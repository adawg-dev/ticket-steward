"""
mitmproxy addon for the run pod's egress sidecar.

The agent's env files hold placeholders (`STEWARD_PH_<NAME>_<16 hex>`) in place of outbound API keys. On a request to
one of a rule's allowlisted hosts the placeholder becomes the real value in the headers (Basic auth decoded and
re-encoded), the query string and the body. To any other host it goes out unchanged and is logged. Every response, from
every host, has the real values turned back into their placeholders, so an API echoing a key ("invalid key sk_test_…")
never shows the agent the real value. Log lines name the placeholder's NAME and the host, never a value.

The rules are Task 8's `EgressRule[]` JSON (`steward render-overlay --rules-out`), read from the `steward_rules` option.
"""

import base64
import binascii
import json
import logging
import re
from collections.abc import Iterable
from dataclasses import dataclass
from fnmatch import fnmatchcase
from urllib.parse import quote, quote_plus

from mitmproxy import exceptions, http

logger = logging.getLogger("steward.egress")

PLACEHOLDER = re.compile(r"^STEWARD_PH_([A-Za-z0-9_]+)_[0-9a-f]{16}$")


@dataclass(frozen=True)
class Rule:
    placeholder: str
    value: str
    hosts: list[str]

    @property
    def name(self) -> str:
        match = PLACEHOLDER.match(self.placeholder)
        return match.group(1) if match else self.placeholder

    def allows(self, host: str) -> bool:
        host = host.lower().rstrip(".")
        return any(fnmatchcase(host, pattern.lower()) for pattern in self.hosts)


def load_rules(path: str) -> list[Rule]:
    """The rules file, refused as a whole if any entry is malformed. Errors name the entry's index, never a value."""
    try:
        with open(path, encoding="utf-8") as handle:
            raw = json.load(handle)
    except (OSError, ValueError) as error:
        raise exceptions.OptionsError(f"egress rules at {path} are unreadable: {type(error).__name__}") from None
    if not isinstance(raw, list):
        raise exceptions.OptionsError(f"egress rules at {path} are not a list")
    rules: list[Rule] = []
    for index, entry in enumerate(raw):
        placeholder = entry.get("placeholder") if isinstance(entry, dict) else None
        value = entry.get("value") if isinstance(entry, dict) else None
        hosts = entry.get("hosts") if isinstance(entry, dict) else None
        if not isinstance(placeholder, str) or not PLACEHOLDER.match(placeholder):
            raise exceptions.OptionsError(f"egress rule {index} has no valid placeholder")
        if not isinstance(value, str) or value == "":
            raise exceptions.OptionsError(f"egress rule {index} ({placeholder}) has no value")
        if not isinstance(hosts, list) or not hosts or not all(isinstance(host, str) and host for host in hosts):
            raise exceptions.OptionsError(f"egress rule {index} ({placeholder}) has no hosts")
        rules.append(Rule(placeholder=placeholder, value=value, hosts=hosts))
    return rules


def encodings(value: str) -> set[str]:
    """The forms a value takes in a body or URL: as is, JSON-escaped and percent-encoded."""
    return {value, json.dumps(value)[1:-1], quote(value, safe=""), quote_plus(value)}


class StreamScrubber:
    """
    Replaces needles in a streamed body without buffering it. Only a tail that could be the start of a needle is held
    back, until the next chunk shows whether it is one, so an SSE event that ends a chunk is sent at once. mitmproxy
    calls it with b"" at the end of the body, which flushes the tail.
    """

    def __init__(self, replacements: dict[bytes, bytes]) -> None:
        self.replacements = replacements
        needles = sorted(replacements, key=len, reverse=True)
        self.pattern = re.compile(b"|".join(re.escape(needle) for needle in needles))
        self.longest = len(needles[0]) if needles else 0
        self.held = b""

    def held_tail(self, buf: bytes) -> int:
        """The length of the longest tail of `buf` that is a proper prefix of a needle."""
        for start in range(max(0, len(buf) - self.longest + 1), len(buf)):
            tail = buf[start:]
            if any(len(needle) > len(tail) and needle.startswith(tail) for needle in self.replacements):
                return len(buf) - start
        return 0

    def __call__(self, data: bytes) -> bytes:
        buf = self.held + data
        if data == b"":
            self.held = b""
            return self.pattern.sub(lambda match: self.replacements[match.group()], buf)
        cut = len(buf) - self.held_tail(buf)
        out: list[bytes] = []
        last = 0
        for match in self.pattern.finditer(buf):
            if match.end() > cut:
                cut = min(cut, match.start())
                break
            out += [buf[last : match.start()], self.replacements[match.group()]]
            last = match.end()
        out.append(buf[last:cut])
        self.held = buf[cut:]
        return b"".join(out)


def is_event_stream(headers: http.Headers) -> bool:
    return headers.get("content-type", "").split(";")[0].strip().lower() == "text/event-stream"


def is_identity(headers: http.Headers) -> bool:
    return headers.get("content-encoding", "identity").strip().lower() in ("", "identity")


class Swap:
    def __init__(self, rules: Iterable[Rule] = ()) -> None:
        self.set_rules(list(rules))

    def set_rules(self, rules: list[Rule]) -> None:
        self.rules = rules
        self.scrub_bytes = {form.encode(): rule.placeholder.encode() for rule in rules for form in encodings(rule.value)}
        needles = sorted(self.scrub_bytes, key=len, reverse=True)
        self.scrub_pattern = re.compile(b"|".join(re.escape(needle) for needle in needles)) if needles else None

    # --- mitmproxy hooks ---

    def load(self, loader) -> None:
        loader.add_option("steward_rules", str, "", "The egress rules file (JSON EgressRule[]) written by steward render-overlay.")

    def configure(self, updated: set[str]) -> None:
        from mitmproxy import ctx

        if "steward_rules" in updated and ctx.options.steward_rules:
            self.set_rules(load_rules(ctx.options.steward_rules))
            logger.info(f"loaded {len(self.rules)} egress rule(s)")

    def request(self, flow: http.HTTPFlow) -> None:
        if not self.rules:
            return
        host = flow.request.host
        swap = [rule for rule in self.rules if rule.allows(host)]
        self.log_refused(host, [rule for rule in self.rules if rule not in swap], self.request_text(flow.request))
        if swap:
            self.swap_request(flow.request, swap)

    def responseheaders(self, flow: http.HTTPFlow) -> None:
        response = flow.response
        if response is None or not is_event_stream(response.headers):
            return
        if self.scrub_pattern is None:
            response.stream = True
        elif is_identity(response.headers):
            self.scrub_headers(response.headers)
            response.stream = StreamScrubber(self.scrub_bytes)
        # A compressed event stream is buffered and scrubbed whole in `response`: its bytes on the wire can't be.

    def response(self, flow: http.HTTPFlow) -> None:
        response = flow.response
        if response is None or self.scrub_pattern is None or response.stream:
            return
        self.scrub_headers(response.headers)
        try:
            content = response.content
        except ValueError:
            # An encoding mitmproxy can't decode: scrub the bytes as they are.
            response.raw_content = self.scrub(response.raw_content)
            return
        if content:
            scrubbed = self.scrub(content)
            if scrubbed != content:
                response.content = scrubbed

    def websocket_message(self, flow: http.HTTPFlow) -> None:
        if flow.websocket is None or not self.rules:
            return
        message = flow.websocket.messages[-1]
        if not message.from_client:
            message.content = self.scrub(message.content)
            return
        host = flow.request.host
        swap = [rule for rule in self.rules if rule.allows(host)]
        text = message.content.decode("utf-8", "replace")
        self.log_refused(host, [rule for rule in self.rules if rule not in swap], [text])
        for rule in swap:
            message.content = message.content.replace(rule.placeholder.encode(), rule.value.encode())

    # --- helpers ---

    def log_refused(self, host: str, refused: list[Rule], texts: list[str]) -> None:
        for rule in refused:
            if any(rule.placeholder in text for text in texts):
                logger.warning(f"placeholder for {rule.name} sent to {host}, not swapped")

    def request_text(self, request: http.Request) -> list[str]:
        """Everything a placeholder can ride in: the URL, header values (Basic auth decoded) and the decoded body."""
        texts = [request.url, *request.headers.values()]
        texts += [decoded for value in request.headers.get_all("authorization") if (decoded := decode_basic(value)) is not None]
        body = request.get_content(strict=False)
        if body:
            texts.append(body.decode("utf-8", "replace"))
        return texts

    def swap_request(self, request: http.Request, rules: list[Rule]) -> None:
        def raw(text: str) -> str:
            for rule in rules:
                text = text.replace(rule.placeholder, rule.value)
            return text

        fields = []
        for name, value in request.headers.fields:
            text = value.decode("latin-1")
            basic = swap_basic(text, rules) if name.lower() == b"authorization" else None
            fields.append((name, raw(basic if basic is not None else text).encode("latin-1")))
        if tuple(fields) != request.headers.fields:
            request.headers.fields = tuple(fields)

        path, sep, query = request.path.partition("?")
        if sep:
            swapped_query = query
            for rule in rules:
                swapped_query = swapped_query.replace(rule.placeholder, quote(rule.value, safe=""))
            if swapped_query != query:
                request.path = f"{path}?{swapped_query}"

        try:
            body = request.content
        except ValueError:
            if any(rule.placeholder.encode() in (request.raw_content or b"") for rule in rules):
                logger.warning(f"request body to {request.host} has an encoding the proxy can't decode, placeholders not swapped")
            return
        if not body:
            return
        content_type = request.headers.get("content-type", "").split(";")[0].strip().lower()
        if content_type == "application/x-www-form-urlencoded":
            encode = quote_plus
        elif content_type == "application/json" or content_type.endswith("+json"):
            encode = lambda value: json.dumps(value)[1:-1]  # noqa: E731
        else:
            encode = lambda value: value  # noqa: E731
        swapped_body = body
        for rule in rules:
            swapped_body = swapped_body.replace(rule.placeholder.encode(), encode(rule.value).encode())
        if swapped_body != body:
            request.content = swapped_body

    def scrub(self, data: bytes | None) -> bytes | None:
        if not data or self.scrub_pattern is None:
            return data
        return self.scrub_pattern.sub(lambda match: self.scrub_bytes[match.group()], data)

    def scrub_headers(self, headers: http.Headers) -> None:
        fields = []
        changed = False
        for name, value in headers.fields:
            scrubbed = self.scrub(value) or value
            changed = changed or scrubbed != value
            fields.append((name, scrubbed))
        if changed:
            headers.fields = tuple(fields)


def decode_basic(value: str) -> str | None:
    scheme, _, token = value.partition(" ")
    if scheme.lower() != "basic":
        return None
    try:
        return base64.b64decode(token.strip(), validate=True).decode("utf-8")
    except (binascii.Error, UnicodeDecodeError):
        return None


def swap_basic(value: str, rules: list[Rule]) -> str | None:
    """`Basic base64(user:placeholder)` with the real value inside, or None when it is not Basic auth."""
    decoded = decode_basic(value)
    if decoded is None:
        return None
    swapped = decoded
    for rule in rules:
        swapped = swapped.replace(rule.placeholder, rule.value)
    if swapped == decoded:
        return value
    return f"{value.partition(' ')[0]} {base64.b64encode(swapped.encode()).decode()}"


addons = [Swap()]
