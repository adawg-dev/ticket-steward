"""The egress addon, against mitmproxy's own flow helpers. Run with `npm run test:egress` inside the egress image."""

import base64
import json
import os
import tempfile
import unittest

from mitmproxy import exceptions, http
from mitmproxy.test import taddons, tflow

from swap import Rule, StreamScrubber, Swap, load_rules

STRIPE_PH = "STEWARD_PH_STRIPE_SECRET_KEY_0123456789abcdef"
STRIPE_REAL = "sk_test_1"
TWILIO_PH = "STEWARD_PH_TWILIO_AUTH_TOKEN_fedcba9876543210"
TWILIO_REAL = "real"
EVERYWHERE = frozenset({"headers", "query", "body"})


def rules() -> list[Rule]:
    return [
        Rule(placeholder=STRIPE_PH, value=STRIPE_REAL, hosts=["api.stripe.com", "*.stripe.com"], swap_in=EVERYWHERE),
        Rule(placeholder=TWILIO_PH, value=TWILIO_REAL, hosts=["api.twilio.com"]),
    ]


def request_flow(url: str, content: bytes = b"", headers: dict[str, str] | None = None) -> http.HTTPFlow:
    return tflow.tflow(req=http.Request.make("POST", url, content, headers or {}))


def respond(flow: http.HTTPFlow, content: bytes, headers: dict[str, str] | None = None) -> http.HTTPFlow:
    flow.response = http.Response.make(200, content, headers or {"content-type": "application/json"})
    return flow


def basic(user: str, password: str) -> str:
    return "Basic " + base64.b64encode(f"{user}:{password}".encode()).decode()


class RequestSwap(unittest.TestCase):
    def setUp(self) -> None:
        self.swap = Swap(rules())

    def test_header_query_and_body_carry_the_real_value_to_an_allowlisted_host(self) -> None:
        flow = request_flow(
            f"https://api.stripe.com/v1/charges?key={STRIPE_PH}&n=1",
            f"token={STRIPE_PH}".encode(),
            {"authorization": f"Bearer {STRIPE_PH}", "content-type": "text/plain"},
        )
        self.swap.request(flow)
        self.assertEqual(flow.request.headers["authorization"], f"Bearer {STRIPE_REAL}")
        self.assertEqual(flow.request.path, f"/v1/charges?key={STRIPE_REAL}&n=1")
        self.assertEqual(flow.request.content, f"token={STRIPE_REAL}".encode())
        self.assertNotIn(STRIPE_PH, flow.request.url)

    def test_a_wildcard_host_matches_its_subdomains_only(self) -> None:
        sub = request_flow("https://files.stripe.com/x", headers={"authorization": f"Bearer {STRIPE_PH}"})
        self.swap.request(sub)
        self.assertEqual(sub.request.headers["authorization"], f"Bearer {STRIPE_REAL}")
        for host in ("stripe.com.evil.example", "evilstripe.com", "a.b.stripe.com", "stripe.com"):
            with self.subTest(host=host), self.assertLogs("steward.egress", "WARNING"):
                flow = request_flow(f"https://{host}/x", headers={"authorization": f"Bearer {STRIPE_PH}"})
                self.swap.request(flow)
                self.assertEqual(flow.request.headers["authorization"], f"Bearer {STRIPE_PH}")

    def test_host_matching_ignores_case_and_a_trailing_dot(self) -> None:
        flow = request_flow("https://API.Stripe.com./x", headers={"authorization": f"Bearer {STRIPE_PH}"})
        self.swap.request(flow)
        self.assertEqual(flow.request.headers["authorization"], f"Bearer {STRIPE_REAL}")

    def test_basic_auth_is_decoded_swapped_and_re_encoded(self) -> None:
        flow = request_flow("https://api.twilio.com/2010-04-01/Accounts", headers={"authorization": basic("AC1", TWILIO_PH)})
        self.swap.request(flow)
        self.assertEqual(flow.request.headers["authorization"], basic("AC1", TWILIO_REAL))

    def test_a_placeholder_to_another_host_goes_out_unchanged_and_is_logged(self) -> None:
        flow = request_flow(
            f"https://evil.example/collect?k={STRIPE_PH}",
            STRIPE_PH.encode(),
            {"authorization": f"Bearer {STRIPE_PH}", "content-type": "text/plain"},
        )
        with self.assertLogs("steward.egress", "WARNING") as logs:
            self.swap.request(flow)
        self.assertEqual(logs.output, ["WARNING:steward.egress:placeholder for STRIPE_SECRET_KEY sent to evil.example, not swapped"])
        self.assertEqual(flow.request.headers["authorization"], f"Bearer {STRIPE_PH}")
        self.assertEqual(flow.request.path, f"/collect?k={STRIPE_PH}")
        self.assertEqual(flow.request.content, STRIPE_PH.encode())

    def test_a_placeholder_inside_basic_auth_to_another_host_stays_the_placeholder(self) -> None:
        flow = request_flow("https://evil.example/", headers={"authorization": basic("AC1", TWILIO_PH)})
        with self.assertLogs("steward.egress", "WARNING") as logs:
            self.swap.request(flow)
        self.assertEqual(logs.output, ["WARNING:steward.egress:placeholder for TWILIO_AUTH_TOKEN sent to evil.example, not swapped"])
        self.assertEqual(flow.request.headers["authorization"], basic("AC1", TWILIO_PH))

    def test_the_host_header_does_not_choose_the_rule(self) -> None:
        flow = request_flow("https://evil.example/", headers={"host": "api.stripe.com", "authorization": f"Bearer {STRIPE_PH}"})
        with self.assertLogs("steward.egress", "WARNING"):
            self.swap.request(flow)
        self.assertEqual(flow.request.headers["authorization"], f"Bearer {STRIPE_PH}")

    def test_only_the_rules_for_that_host_are_swapped(self) -> None:
        flow = request_flow("https://api.stripe.com/", headers={"x-api-key": STRIPE_PH, "x-auth-token": TWILIO_PH})
        with self.assertLogs("steward.egress", "WARNING") as logs:
            self.swap.request(flow)
        self.assertEqual(logs.output, ["WARNING:steward.egress:placeholder for TWILIO_AUTH_TOKEN sent to api.stripe.com, not swapped"])
        self.assertEqual(flow.request.headers["x-api-key"], STRIPE_REAL)
        self.assertEqual(flow.request.headers["x-auth-token"], TWILIO_PH)

    def test_by_default_only_credential_headers_carry_the_real_value(self) -> None:
        swap = Swap([Rule(placeholder=TWILIO_PH, value=TWILIO_REAL, hosts=["api.twilio.com"])])
        flow = request_flow(
            f"https://api.twilio.com/x?k={TWILIO_PH}",
            json.dumps({"note": TWILIO_PH}).encode(),
            {"authorization": f"Bearer {TWILIO_PH}", "x-api-key": TWILIO_PH, "x-note": TWILIO_PH, "content-type": "application/json"},
        )
        with self.assertLogs("steward.egress", "WARNING") as logs:
            swap.request(flow)
        self.assertEqual(flow.request.headers["authorization"], f"Bearer {TWILIO_REAL}")
        self.assertEqual(flow.request.headers["x-api-key"], TWILIO_REAL)
        self.assertEqual(flow.request.headers["x-note"], TWILIO_PH)
        self.assertEqual(flow.request.path, f"/x?k={TWILIO_PH}")
        self.assertEqual(json.loads(flow.request.content or b""), {"note": TWILIO_PH})
        self.assertEqual(
            logs.output,
            [
                f"WARNING:steward.egress:placeholder for TWILIO_AUTH_TOKEN in {place} to api.twilio.com, not swapped: its rule swaps headers only"
                for place in ("the x-note header", "the query string", "the body")
            ],
        )

    def test_a_rule_that_opts_in_to_the_query_does_not_swap_the_body(self) -> None:
        swap = Swap([Rule(placeholder=TWILIO_PH, value=TWILIO_REAL, hosts=["api.twilio.com"], swap_in=frozenset({"headers", "query"}))])
        flow = request_flow(f"https://api.twilio.com/x?k={TWILIO_PH}", TWILIO_PH.encode(), {"content-type": "text/plain"})
        with self.assertLogs("steward.egress", "WARNING"):
            swap.request(flow)
        self.assertEqual(flow.request.path, f"/x?k={TWILIO_REAL}")
        self.assertEqual(flow.request.content, TWILIO_PH.encode())

    def test_the_value_is_encoded_for_the_part_it_lands_in(self) -> None:
        swap = Swap([Rule(placeholder=STRIPE_PH, value='a b&c"\\', hosts=["api.stripe.com"], swap_in=EVERYWHERE)])
        form = request_flow(
            f"https://api.stripe.com/x?k={STRIPE_PH}", f"key={STRIPE_PH}&n=1".encode(), {"content-type": "application/x-www-form-urlencoded"}
        )
        swap.request(form)
        self.assertEqual(form.request.query["k"], 'a b&c"\\')
        self.assertEqual(form.request.urlencoded_form["key"], 'a b&c"\\')
        self.assertEqual(form.request.urlencoded_form["n"], "1")
        body = request_flow("https://api.stripe.com/x", json.dumps({"key": STRIPE_PH}).encode(), {"content-type": "application/json; charset=utf-8"})
        swap.request(body)
        self.assertEqual(json.loads(body.request.content or b""), {"key": 'a b&c"\\'})

    def test_a_compressed_body_is_swapped_and_recompressed(self) -> None:
        flow = request_flow("https://api.stripe.com/x")
        flow.request.headers["content-encoding"] = "gzip"
        flow.request.content = STRIPE_PH.encode()
        self.swap.request(flow)
        self.assertEqual(flow.request.headers["content-encoding"], "gzip")
        self.assertEqual(flow.request.content, STRIPE_REAL.encode())
        self.assertNotIn(STRIPE_PH.encode(), flow.request.raw_content or b"")

    def test_a_request_without_placeholders_is_left_alone(self) -> None:
        flow = request_flow("https://registry.npmjs.org/left-pad?x=1", b"{}", {"accept": "*/*"})
        before = flow.request.get_state()
        self.swap.request(flow)
        self.assertEqual(flow.request.get_state(), before)


class ResponseScrub(unittest.TestCase):
    def setUp(self) -> None:
        self.swap = Swap(rules())

    def test_an_echoed_real_value_reaches_the_client_as_its_placeholder_for_every_host(self) -> None:
        for host in ("api.stripe.com", "evil.example", "api.twilio.com"):
            with self.subTest(host=host):
                flow = respond(request_flow(f"https://{host}/"), f'{{"error":"invalid key {STRIPE_REAL}","t":"{TWILIO_REAL}"}}'.encode())
                flow.response.headers["x-echo"] = STRIPE_REAL
                self.swap.responseheaders(flow)
                self.swap.response(flow)
                self.assertEqual(flow.response.content, f'{{"error":"invalid key {STRIPE_PH}","t":"{TWILIO_PH}"}}'.encode())
                self.assertEqual(flow.response.headers["x-echo"], STRIPE_PH)

    def test_escaped_forms_of_the_value_are_scrubbed_too(self) -> None:
        value = 'k/y+z"1'
        swap = Swap([Rule(placeholder=STRIPE_PH, value=value, hosts=["api.stripe.com"])])
        escaped = json.dumps(value)[1:-1]
        flow = respond(request_flow("https://api.stripe.com/"), f"{escaped} k%2Fy%2Bz%221 k%2Fy%2Bz%221".encode())
        swap.response(flow)
        self.assertEqual(flow.response.content, f"{STRIPE_PH} {STRIPE_PH} {STRIPE_PH}".encode())

    def test_base64_and_other_json_escapes_of_the_value_are_scrubbed(self) -> None:
        value = "AKIA/abc+def/ghi=jkl"
        swap = Swap([Rule(placeholder=STRIPE_PH, value=value, hosts=["api.stripe.com"])])
        reflected = [
            base64.b64encode(f"AC1:{value}".encode()).decode(),
            base64.b64encode(f"x{value}y".encode()).decode(),
            base64.urlsafe_b64encode(f"ab{value}".encode()).decode(),
            json.dumps(value)[1:-1].replace("/", "\\/"),
            "".join(f"\\u{ord(char):04x}" for char in value),
            "".join(f"\\u{ord(char):04X}" for char in value),
        ]
        flow = respond(request_flow("https://api.stripe.com/"), " ".join(reflected).encode())
        swap.response(flow)
        content = (flow.response.content or b"").decode()
        for form in reflected:
            with self.subTest(form=form):
                self.assertNotIn(form, content)
        self.assertEqual(content.count(STRIPE_PH), len(reflected))

    def test_trailers_are_scrubbed(self) -> None:
        flow = respond(request_flow("https://api.stripe.com/"), b"{}")
        flow.response.trailers = http.Headers(x_echo=STRIPE_REAL)
        self.swap.response(flow)
        self.assertEqual(flow.response.trailers["x-echo"], STRIPE_PH)

    def test_a_compressed_response_is_scrubbed(self) -> None:
        flow = respond(request_flow("https://api.stripe.com/"), b"")
        flow.response.headers["content-encoding"] = "gzip"
        flow.response.content = f"bad {STRIPE_REAL}".encode()
        self.swap.response(flow)
        self.assertEqual(flow.response.content, f"bad {STRIPE_PH}".encode())

    def test_an_event_stream_is_streamed_and_scrubbed_on_the_way(self) -> None:
        flow = respond(request_flow("https://api.stripe.com/"), b"", {"content-type": "text/event-stream"})
        flow.response.content = None
        self.swap.responseheaders(flow)
        stream = flow.response.stream
        self.assertTrue(callable(stream))
        assert callable(stream)
        self.assertEqual(stream(b"data: one\n\n"), b"data: one\n\n")
        self.assertEqual(stream(f"data: {STRIPE_REAL}\n\n".encode()), f"data: {STRIPE_PH}\n\n".encode())

    def test_an_event_stream_without_rules_is_still_streamed(self) -> None:
        flow = respond(request_flow("https://api.stripe.com/"), b"", {"content-type": "text/event-stream; charset=utf-8"})
        Swap([]).responseheaders(flow)
        self.assertTrue(flow.response.stream)

    def test_a_compressed_event_stream_is_buffered_so_it_can_be_scrubbed(self) -> None:
        flow = respond(request_flow("https://api.stripe.com/"), b"", {"content-type": "text/event-stream", "content-encoding": "gzip"})
        self.swap.responseheaders(flow)
        self.assertFalse(flow.response.stream)

    def test_other_responses_are_buffered(self) -> None:
        flow = respond(request_flow("https://api.stripe.com/"), b"{}")
        self.swap.responseheaders(flow)
        self.assertFalse(flow.response.stream)


class Streaming(unittest.TestCase):
    def scrubber(self) -> StreamScrubber:
        return StreamScrubber({b"sk_test_1": b"PH_A", b"bcx": b"PH_B", b"abc": b"PH_C"})

    def test_a_value_split_across_chunks_is_scrubbed(self) -> None:
        scrub = self.scrubber()
        out = scrub(b"data: sk_te") + scrub(b"st_1 more\n\n") + scrub(b"")
        self.assertEqual(out, b"data: PH_A more\n\n")

    def test_only_a_possible_start_of_a_value_is_held_back(self) -> None:
        scrub = self.scrubber()
        self.assertEqual(scrub(b"data: x\n\n"), b"data: x\n\n")
        self.assertEqual(scrub(b"data: sk_"), b"data: ")
        self.assertEqual(scrub(b""), b"sk_")

    def test_a_match_that_overlaps_a_held_prefix_is_not_lost(self) -> None:
        scrub = self.scrubber()
        out = scrub(b"abc") + scrub(b"y") + scrub(b"")
        self.assertEqual(out, b"PH_Cy")

    def test_the_longest_value_wins_at_a_position(self) -> None:
        scrub = StreamScrubber({b"abc": b"PH_C", b"abcdef": b"PH_D"})
        out = scrub(b"xabc") + scrub(b"def") + scrub(b"")
        self.assertEqual(out, b"xPH_D")


class WebSockets(unittest.TestCase):
    def test_client_messages_are_swapped_for_an_allowlisted_host_and_server_messages_scrubbed(self) -> None:
        swap = Swap([Rule(placeholder=STRIPE_PH, value=STRIPE_REAL, hosts=["example.com"], swap_in=EVERYWHERE)])
        flow = tflow.twebsocketflow()
        assert flow.websocket is not None
        flow.websocket.messages[-1].content = f"auth {STRIPE_PH}".encode()
        flow.websocket.messages[-1].from_client = True
        swap.websocket_message(flow)
        self.assertEqual(flow.websocket.messages[-1].content, f"auth {STRIPE_REAL}".encode())
        flow.websocket.messages[-1].from_client = False
        flow.websocket.messages[-1].content = f"bad {STRIPE_REAL}".encode()
        swap.websocket_message(flow)
        self.assertEqual(flow.websocket.messages[-1].content, f"bad {STRIPE_PH}".encode())

    def test_a_client_message_is_not_swapped_unless_the_rule_swaps_bodies(self) -> None:
        swap = Swap([Rule(placeholder=STRIPE_PH, value=STRIPE_REAL, hosts=["example.com"])])
        flow = tflow.twebsocketflow()
        assert flow.websocket is not None
        flow.websocket.messages[-1].content = f"auth {STRIPE_PH}".encode()
        flow.websocket.messages[-1].from_client = True
        with self.assertLogs("steward.egress", "WARNING"):
            swap.websocket_message(flow)
        self.assertEqual(flow.websocket.messages[-1].content, f"auth {STRIPE_PH}".encode())

    def test_a_client_message_to_another_host_is_logged_and_unchanged(self) -> None:
        swap = Swap([Rule(placeholder=STRIPE_PH, value=STRIPE_REAL, hosts=["api.stripe.com"])])
        flow = tflow.twebsocketflow()
        assert flow.websocket is not None
        flow.websocket.messages[-1].content = STRIPE_PH.encode()
        flow.websocket.messages[-1].from_client = True
        with self.assertLogs("steward.egress", "WARNING") as logs:
            swap.websocket_message(flow)
        self.assertEqual(logs.output, ["WARNING:steward.egress:placeholder for STRIPE_SECRET_KEY sent to example.com, not swapped"])
        self.assertEqual(flow.websocket.messages[-1].content, STRIPE_PH.encode())


class RulesFile(unittest.TestCase):
    def write(self, content: str) -> str:
        handle, path = tempfile.mkstemp(suffix=".json")
        with os.fdopen(handle, "w") as out:
            out.write(content)
        self.addCleanup(os.unlink, path)
        return path

    def test_the_rules_option_loads_the_rendered_rules_file(self) -> None:
        path = self.write(json.dumps([{"placeholder": STRIPE_PH, "value": STRIPE_REAL, "hosts": ["api.stripe.com"]}]))
        swap = Swap()
        with taddons.context(swap) as tctx:
            tctx.configure(swap, steward_rules=path)
            flow = request_flow("https://api.stripe.com/", headers={"authorization": f"Bearer {STRIPE_PH}"})
            swap.request(flow)
        self.assertEqual(flow.request.headers["authorization"], f"Bearer {STRIPE_REAL}")

    def test_a_malformed_rules_file_is_refused_without_echoing_its_values(self) -> None:
        for content in ("{", "{}", json.dumps([{"placeholder": "x", "value": STRIPE_REAL, "hosts": ["a"]}]),
                        json.dumps([{"placeholder": STRIPE_PH, "value": "", "hosts": ["a"]}]),
                        json.dumps([{"placeholder": STRIPE_PH, "value": STRIPE_REAL, "hosts": []}]),
                        json.dumps([{"placeholder": STRIPE_PH, "value": STRIPE_REAL, "hosts": ["*.com"]}]),
                        json.dumps([{"placeholder": STRIPE_PH, "value": STRIPE_REAL, "hosts": ["api.*.com"]}]),
                        json.dumps([{"placeholder": STRIPE_PH, "value": STRIPE_REAL, "hosts": ["a.example"], "swapIn": ["body"]}]),
                        json.dumps([{"placeholder": STRIPE_PH, "value": STRIPE_REAL, "hosts": ["a.example"], "swapIn": ["headers", "cookies"]}])):
            with self.subTest(content=content):
                with self.assertRaises(exceptions.OptionsError) as raised:
                    load_rules(self.write(content))
                self.assertNotIn(STRIPE_REAL, str(raised.exception))

    def test_a_rule_without_swap_in_swaps_headers_only(self) -> None:
        rules = load_rules(self.write(json.dumps([{"placeholder": STRIPE_PH, "value": STRIPE_REAL, "hosts": ["api.stripe.com"]},
                                                   {"placeholder": TWILIO_PH, "value": TWILIO_REAL, "hosts": ["api.twilio.com"], "swapIn": ["headers", "body"]}])))
        self.assertEqual([rule.swap_in for rule in rules], [frozenset({"headers"}), frozenset({"headers", "body"})])

    def test_a_missing_rules_file_is_refused(self) -> None:
        with self.assertRaises(exceptions.OptionsError):
            load_rules("/nonexistent/rules.json")


if __name__ == "__main__":
    unittest.main()
