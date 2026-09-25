/** Exact text of ticket-gateway's footer marker (ticket-gateway internal/linear/render.go FooterMarker). */
export const GATEWAY_FOOTER_MARKER = "Routed by ticket-gateway";

export interface GatewayRoute {
  className: string;
  teamKey: string;
}

// Linear may store "---" as "* * *" or "***", so accept any markdown thematic break.
const RULE = /^\s*(?:(?:-\s*){3,}|(?:\*\s*){3,}|(?:_\s*){3,})$/;
const ROUTE = /class `([a-z_]+)`[^→\n]*→ ([A-Z][A-Z0-9]*)/;

/** Index of the last non-empty line, or -1. */
const lastContentLine = (lines: string[]): number => {
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    if ((lines[i] ?? "").trim() !== "") return i;
  }
  return -1;
};

/** The gateway writes its footer as the last line; a marker anywhere else is quoted text, not provenance. */
const footerLine = (lines: string[]): number => {
  const last = lastContentLine(lines);
  return last !== -1 && (lines[last] ?? "").includes(GATEWAY_FOOTER_MARKER) ? last : -1;
};

export const isGatewayIssue = (description: string): boolean => footerLine(description.split("\n")) !== -1;

export const gatewayRoute = (description: string): GatewayRoute | null => {
  const lines = description.split("\n");
  const index = footerLine(lines);
  if (index === -1) return null;
  const match = ROUTE.exec(lines[index] ?? "");
  if (match?.[1] === undefined || match[2] === undefined) return null;
  return { className: match[1], teamKey: match[2] };
};

export const gatewayFooterStart = (description: string): number | null => {
  const lines = description.split("\n");
  const index = footerLine(lines);
  if (index === -1) return null;
  let anchor = index;
  for (let i = index - 1; i >= 0; i -= 1) {
    const line = lines[i] ?? "";
    if (line.trim() === "") continue;
    if (RULE.test(line)) anchor = i;
    break;
  }
  return lines.slice(0, anchor).reduce((offset, line) => offset + line.length + 1, 0);
};
