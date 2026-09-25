import { gatewayFooterStart, gatewayRoute, isGatewayIssue } from "../../src/core/gateway.js";

const footer = "_Routed by ticket-gateway · class `gateway` (p=0.91, margin 0.40, auto) → RSPNS via `/v1/responses` · jev-routing@c89597f9 · reported by Ana via Slack message_shortcut · [source](https://x.slack.com/archives/C1/p1)_";
const gatewayDescription = `Streaming stops early.\n\n## Slack conversation\n\n> **author:** it cuts off\n\n---\n\n${footer}`;

describe("isGatewayIssue", () => {
  it("detects the gateway footer on the last line", () => {
    expect(isGatewayIssue(gatewayDescription)).toBe(true);
    expect(isGatewayIssue(`${gatewayDescription}\n\n`)).toBe(true);
  });

  it("detects a Linear-normalized footer", () => {
    const normalized = gatewayDescription.replace("---", "* * *").replace(/^_|_$/gm, "*");
    expect(isGatewayIssue(normalized)).toBe(true);
  });

  it("ignores the marker when it is not the last line", () => {
    expect(isGatewayIssue(`${gatewayDescription}\n\nI pasted that from another ticket.`)).toBe(false);
  });

  it("is false for empty and ordinary descriptions", () => {
    expect(isGatewayIssue("")).toBe(false);
    expect(isGatewayIssue("Login fails on Safari.")).toBe(false);
  });
});

describe("gatewayRoute", () => {
  it("parses class and team, ignoring a sub-route", () => {
    expect(gatewayRoute(gatewayDescription)).toEqual({ className: "gateway", teamKey: "RSPNS" });
  });

  it("parses a fallback footer", () => {
    const fallback = "x\n\n---\n\n_Routed by ticket-gateway · class `manual_triage` (reason low_confidence; predicted `billing` p=0.41) → API · reported by Bo via Slack /ticket_";
    expect(gatewayRoute(fallback)).toEqual({ className: "manual_triage", teamKey: "API" });
  });

  it("returns null when the footer has no parsable route or is absent", () => {
    expect(gatewayRoute("x\n\n---\n\n_Routed by ticket-gateway · something else_")).toBeNull();
    expect(gatewayRoute("no footer")).toBeNull();
  });
});

describe("gatewayFooterStart", () => {
  it("points at the rule above the footer", () => {
    const start = gatewayFooterStart(gatewayDescription);
    expect(start).not.toBeNull();
    expect(gatewayDescription.slice(start ?? 0)).toBe(`---\n\n${footer}`);
  });

  it("points at the footer line when there is no rule", () => {
    const noRule = `Body\n\n${footer}`;
    expect(noRule.slice(gatewayFooterStart(noRule) ?? 0)).toBe(footer);
  });

  it("is null without a gateway footer", () => {
    expect(gatewayFooterStart("Body only")).toBeNull();
  });
});
