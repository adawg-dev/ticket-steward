import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PanelEvent } from "../../src/linear/activities.js";
import { ActivityPoster } from "../../src/linear/poster.js";
import type { ActivityContent, LinearAgentApi, PlanStep } from "../../src/tracker/linear/agent.js";

type Call =
  | { kind: "activity"; sessionId: string; content: ActivityContent; ephemeral: boolean; at: number }
  | { kind: "plan"; sessionId: string; plan: PlanStep[]; at: number };

const fakeApi = (calls: Call[], fail = false): LinearAgentApi => ({
  createActivity: async (sessionId, content, opts) => {
    calls.push({ kind: "activity", sessionId, content, ephemeral: opts?.ephemeral ?? false, at: Date.now() });
    if (fail) throw new Error("linear down");
  },
  setPlan: async (sessionId, plan) => {
    calls.push({ kind: "plan", sessionId, plan, at: Date.now() });
  },
  setExternalUrls: async () => undefined,
  setDelegate: async () => undefined,
  moveToState: async () => "moved",
  issueState: async () => ({ type: "started", name: "In Progress" }),
});

const thought = (body: string): PanelEvent => ({ activity: { type: "thought", body }, ephemeral: false });
const running = (parameter: string): PanelEvent => ({ activity: { type: "action", action: "Running", parameter }, ephemeral: true });
const ran = (parameter: string, result = "ok"): PanelEvent => ({ activity: { type: "action", action: "Running", parameter, result }, ephemeral: false });
const editing = (parameter: string, result?: string): PanelEvent => ({
  activity: { type: "action", action: "Editing", parameter, ...(result === undefined ? {} : { result }) },
  ephemeral: result === undefined,
});

const makePoster = (calls: Call[], opts: { sessionId?: string | null; fail?: boolean } = {}): ActivityPoster =>
  new ActivityPoster({
    api: fakeApi(calls, opts.fail),
    sessionId: () => (opts.sessionId === undefined ? "session-1" : opts.sessionId),
    intervalMs: () => 2000,
    now: () => Date.now(),
    setTimer: setTimeout,
  });

const bodies = (calls: Call[]): string =>
  calls.map((call) => (call.kind === "activity" && "body" in call.content ? call.content.body : "")).join("\n");

describe("ActivityPoster", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-29T10:00:00Z"));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("posts the first event at once and spaces the next by the interval", async () => {
    const calls: Call[] = [];
    const poster = makePoster(calls);
    poster.push(thought("one"));
    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ kind: "activity", sessionId: "session-1", content: { type: "thought", body: "one" }, ephemeral: false });
    poster.push(running("pnpm test"));
    await vi.advanceTimersByTimeAsync(1999);
    expect(calls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(calls).toHaveLength(2);
    expect(calls[1]).toMatchObject({ kind: "activity", content: { type: "action", action: "Running" }, ephemeral: true });
  });

  it("keeps a burst of 200 events in 10 s to at most 6 calls and loses no thought text", async () => {
    const calls: Call[] = [];
    const poster = makePoster(calls);
    const thoughts: string[] = [];
    for (let i = 0; i < 200; i += 1) {
      if (i % 4 === 0) {
        const text = `thought number ${i}`;
        thoughts.push(text);
        poster.push(thought(text));
      } else if (i % 4 === 1) poster.push(running(`cmd ${i}`));
      else if (i % 4 === 2) poster.push(ran(`cmd ${i}`, i % 8 === 2 ? "ok" : "failed"));
      else poster.push(editing(`src/f${i}.ts`));
      await vi.advanceTimersByTimeAsync(50);
    }
    expect(calls.length).toBeLessThanOrEqual(6);
    const during = calls.map((call) => call.at);
    for (let i = 1; i < during.length; i += 1) expect((during[i] ?? 0) - (during[i - 1] ?? 0)).toBeGreaterThanOrEqual(2000);
    await poster.flush();
    expect(calls.length).toBeLessThanOrEqual(during.length + 3);
    const sent = bodies(calls);
    for (const text of thoughts) expect(sent).toContain(text);
  });

  it("merges queued finished actions of one kind into one activity when behind", async () => {
    const calls: Call[] = [];
    const poster = makePoster(calls);
    poster.push(thought("first"));
    await vi.advanceTimersByTimeAsync(0);
    poster.push(editing("src/a.ts", "ok"));
    poster.push(ran("pnpm lint", "ok"));
    poster.push(editing("src/b.ts", "failed"));
    poster.push(editing("src/a.ts", "ok"));
    await poster.flush();
    expect(calls.slice(1).map((call) => (call.kind === "activity" ? call.content : call.kind))).toEqual([
      { type: "action", action: "Editing", parameter: "src/a.ts, src/b.ts", result: "1 of 3 failed" },
      { type: "action", action: "Running", parameter: "pnpm lint", result: "ok" },
    ]);
  });

  it("drops queued ephemeral events first when behind", async () => {
    const calls: Call[] = [];
    const poster = makePoster(calls);
    poster.push(thought("first"));
    await vi.advanceTimersByTimeAsync(0);
    poster.push(running("a"));
    poster.push(running("b"));
    poster.push(thought("second"));
    await vi.advanceTimersByTimeAsync(2000);
    expect(calls.map((call) => (call.kind === "activity" ? call.content.type : call.kind))).toEqual(["thought", "thought"]);
    expect(calls[1]).toMatchObject({ content: { body: "second" } });
  });

  it("merges queued thoughts into one activity when behind", async () => {
    const calls: Call[] = [];
    const poster = makePoster(calls);
    poster.push(thought("first"));
    await vi.advanceTimersByTimeAsync(0);
    poster.push(thought("second"));
    poster.push(running("x"));
    poster.push(thought("third"));
    await vi.advanceTimersByTimeAsync(2000);
    expect(calls).toHaveLength(2);
    expect(calls[1]).toMatchObject({ content: { type: "thought", body: "second\n\nthird" } });
  });

  it("collapses queued plan updates to the latest", async () => {
    const calls: Call[] = [];
    const poster = makePoster(calls);
    poster.push(thought("first"));
    await vi.advanceTimersByTimeAsync(0);
    poster.push({ plan: [{ content: "a", status: "pending" }] });
    poster.push({ plan: [{ content: "a", status: "inProgress" }] });
    poster.push({ plan: [{ content: "a", status: "completed" }] });
    await vi.advanceTimersByTimeAsync(2000);
    await vi.advanceTimersByTimeAsync(10_000);
    const plans = calls.filter((call) => call.kind === "plan");
    expect(plans).toHaveLength(1);
    expect(plans[0]).toMatchObject({ plan: [{ content: "a", status: "completed" }] });
  });

  it("flush sends everything left except ephemerals, without waiting for the interval", async () => {
    const calls: Call[] = [];
    const poster = makePoster(calls);
    poster.push(thought("first"));
    await vi.advanceTimersByTimeAsync(0);
    poster.push(running("x"));
    poster.push(ran("x"));
    poster.push({ plan: [{ content: "a", status: "completed" }] });
    poster.push(thought("last words"));
    await poster.flush();
    expect(calls.map((call) => (call.kind === "activity" ? `${call.content.type}:${String(call.ephemeral)}` : call.kind))).toEqual([
      "thought:false",
      "action:false",
      "plan",
      "thought:false",
    ]);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(calls).toHaveLength(4);
  });

  it("never drops or merges a response, elicitation or error", async () => {
    const calls: Call[] = [];
    const poster = makePoster(calls);
    poster.push(thought("first"));
    await vi.advanceTimersByTimeAsync(0);
    poster.push(thought("a"));
    poster.push({ activity: { type: "response", body: "Done." }, ephemeral: false });
    poster.push(thought("b"));
    await poster.flush();
    expect(calls.map((call) => (call.kind === "activity" ? call.content.type : call.kind))).toEqual(["thought", "thought", "response", "thought"]);
  });

  it("posts nothing while the issue has no session", async () => {
    const calls: Call[] = [];
    const poster = makePoster(calls, { sessionId: null });
    poster.push(thought("first"));
    await vi.advanceTimersByTimeAsync(5000);
    await poster.flush();
    expect(calls).toHaveLength(0);
  });

  it("survives a failing Linear call and keeps posting", async () => {
    const calls: Call[] = [];
    const poster = makePoster(calls, { fail: true });
    poster.push(thought("first"));
    await vi.advanceTimersByTimeAsync(0);
    poster.push(thought("second"));
    await vi.advanceTimersByTimeAsync(2000);
    await expect(poster.flush()).resolves.toBeUndefined();
    expect(calls).toHaveLength(2);
  });
});
