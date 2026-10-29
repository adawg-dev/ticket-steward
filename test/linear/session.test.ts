import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Redactor } from "../../src/core/redact.js";
import type { ImplementResult } from "../../src/implement/result.js";
import { linearIntake } from "../../src/linear/intake.js";
import { answerLinearIntake, failureContent, implementFinish, linearSessionFor, PANEL_TEXT, steerText, stoppedResponse } from "../../src/linear/session.js";
import { RunChannels } from "../../src/run/channel.js";
import { seedSettings } from "../../src/settings/schema.js";
import { openStores, type Stores } from "../../src/store/index.js";
import type { StewardConfig } from "../../src/config/schema.js";
import type { LinearEvent } from "../../src/tracker/linear/webhook.js";
import { RecordingLinear } from "../fakes/fakeLinearAgent.js";

let dataDir: string;
let stores: Stores;
let linear: RecordingLinear;

const makeConfig = (): StewardConfig => ({
  dataDir,
  brain: { kind: "claude-code", model: "claude-test", maxTurns: 5, timeoutMinutes: 1 },
  tracker: { kind: "linear", teams: ["API"] },
  codehost: { kind: "gitlab", baseUrl: "https://gitlab.example", project: "acme/repo" },
  workspace: {
    fetchUrl: "https://gitlab.example/acme/repo.git",
    baseBranch: "dev",
    overlayDir: join(dataDir, "overlay"),
    setup: [],
    setupTimeoutMinutes: 1,
    port: 4100,
    keepOnFailure: true,
  },
  retention: { keptWorktrees: 3, days: 30 },
  server: { port: 3020, publicUrl: "https://steward.example" },
  implement: {
    prompt: "./prompts/implement.md",
    branchTypes: ["fix"],
    checks: [],
    checksTimeoutMinutes: 1,
    commitAuthor: { name: "Ticket Steward", email: "steward@example.com" },
    timeoutMinutes: 1,
    maxTurns: 5,
    protectedBranches: ["main"],
  },
});

const panelDeps = (redactor = new Redactor([])) => ({ linear, stores, redactor, settings: { get: () => seedSettings(makeConfig()) } });

const ticket = { issueId: "issue-1", identifier: "API-1", teamKey: "API" };
let delivery = 0;
const created = (): LinearEvent => ({
  kind: "session.created", deliveryId: `d-${++delivery}`, sessionId: "session-1", ...ticket, delegated: true, commentBody: null, promptContext: "", byApp: false,
});
const prompted = (body: string, stop = false): LinearEvent => ({
  kind: "session.prompted", deliveryId: `d-${++delivery}`, sessionId: "session-1", ...ticket, body, stop, authorName: "Ada", byApp: false,
});

const assistantText = (text: string): string => JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text }] } });

const implemented: ImplementResult = {
  outcome: "implemented",
  summary: "Flush the buffer before closing the stream.",
  reviewNotes: [],
  checksRun: ["pnpm test: ok"],
  questions: [],
  failureDetail: null,
  media: [],
};

beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "steward-session-"));
  stores = openStores(dataDir);
  linear = new RecordingLinear();
});

afterEach(async () => {
  stores.db.close();
  await rm(dataDir, { recursive: true, force: true });
});

describe("linearSessionFor", () => {
  it("makes no Linear call for a ticket Linear never opened a session for", async () => {
    const session = linearSessionFor(panelDeps(), "issue-1");
    session.thought("hello");
    session.hooks.onLine?.(assistantText("Reading the adapter."));
    await session.setMrUrl("https://gitlab.example/acme/repo/-/merge_requests/7");
    await session.finish({ type: "response", body: "done" });
    expect(session.poster).toBeNull();
    expect(linear.calls).toEqual([]);
  });

  it("posts the brain's lines to the ticket's current session, then the final activity", async () => {
    stores.agentSessions.record("session-1", "issue-1", "API-1");
    const session = linearSessionFor(panelDeps(), "issue-1");
    session.hooks.onLine?.(assistantText("Reading the adapter."));
    await session.finish({ type: "response", body: "Done." });
    expect(linear.activities().map((call) => [call.sessionId, call.content])).toEqual([
      ["session-1", { type: "thought", body: "Reading the adapter." }],
      ["session-1", { type: "response", body: "Done." }],
    ]);
    expect(session.lastThought()).toBe("Reading the adapter.");
  });

  it("scrubs what it posts with the run redactor and placeholder stripping", async () => {
    stores.agentSessions.record("session-1", "issue-1", "API-1");
    const session = linearSessionFor(panelDeps(new Redactor(["s3cret-value"])), "issue-1");
    await session.finish({ type: "response", body: "used s3cret-value and STEWARD_PH_DB_0123456789abcdef" });
    const body = linear.activities()[0]?.content;
    expect(body).toEqual({ type: "response", body: expect.not.stringContaining("s3cret-value") });
    expect(JSON.stringify(body)).toContain("[placeholder]");
  });

  it("links the merge request from the session", async () => {
    stores.agentSessions.record("session-1", "issue-1", "API-1");
    await linearSessionFor(panelDeps(), "issue-1").setMrUrl("https://gitlab.example/mr/7");
    expect(linear.calls).toEqual([{ kind: "urls", sessionId: "session-1", urls: [{ label: "Merge request", url: "https://gitlab.example/mr/7" }] }]);
  });
});

describe("panel contents", () => {
  it("asks the questions of a needs_info implement as an elicitation", () => {
    const content = implementFinish({ result: { ...implemented, outcome: "needs_info", questions: ["Which adapter?", "Keep v1?"] }, handback: { label: "needsInfo", reason: "the ticket needs more information", detail: "" } });
    expect(content).toEqual({ type: "elicitation", body: expect.stringContaining("- Which adapter?\n- Keep v1?") });
  });

  it("answers a pushed implement with its summary and checks", () => {
    expect(implementFinish({ result: implemented, handback: null })).toEqual({
      type: "response",
      body: "Flush the buffer before closing the stream.\n\n**Checks I ran**\n- pnpm test: ok",
    });
  });

  it("reports a hand-back as an error with its reason, never its detail", () => {
    const content = implementFinish({ result: null, handback: { label: "readyForHuman", reason: "the agent left unpushed work", detail: "M src/secret-output.ts" } });
    expect(content).toEqual({ type: "error", body: "I stopped and handed this back: the agent left unpushed work." });
  });

  it("says where a stopped run got to and what it pushed", () => {
    expect(stoppedResponse("Tests pass locally.", "abcdef1234567890")).toEqual({ type: "response", body: "Stopped. Where I got to: Tests pass locally.\n\nLast pushed commit: abcdef1." });
  });

  it("shows only the first line of a failure", () => {
    expect(failureContent("setup failed:\nnpm ERR! secret tail")).toEqual({ type: "error", body: "The run failed: setup failed:" });
  });
});

describe("answerLinearIntake", () => {
  const intakeDeps = () => ({ config: makeConfig(), stores, settings: { get: () => seedSettings(makeConfig()) } });

  it("posts the first thought on a delegation while the implement job is still queued", async () => {
    const event = created();
    const result = await linearIntake(intakeDeps(), event);
    await answerLinearIntake(panelDeps(), event, result);
    expect(result.action).toBe("implement");
    expect(stores.jobs.get(result.jobId ?? 0)?.status).toBe("queued");
    expect(linear.activities()[0]).toMatchObject({ sessionId: "session-1", content: { type: "thought", body: PANEL_TEXT.pickedUp }, ephemeral: false });
  });

  it("hands a prompt to the open run as a steering message", async () => {
    const channels = new RunChannels();
    channels.open("7-1", () => undefined, "issue-1");
    const steer = vi.spyOn(channels, "steer");
    const event = prompted("use v2 of the API");
    await answerLinearIntake({ ...panelDeps(), channels }, event, { action: "steer" });
    expect(steer).toHaveBeenCalledWith("7-1", steerText("Ada", "use v2 of the API"));
    expect(steerText("Ada", "use v2 of the API")).toBe("Message from Ada in Linear while you were working:\nuse v2 of the API");
    expect(await channels.next("7-1", 0)).toEqual([{ type: "steer", message: steerText("Ada", "use v2 of the API") }]);
  });

  it("answers a steer that finds no open run with a chat after it", async () => {
    await answerLinearIntake({ ...panelDeps(), channels: new RunChannels() }, prompted("and the docs?"), { action: "steer" });
    const [job] = stores.jobs.list({ limit: 10 });
    expect(job?.kind).toBe("chat");
    expect(job?.trigger).toMatchObject({ kind: "linear", run: "chat", message: "and the docs?", author: "Ada" });
  });

  it("stops the open run and leaves the answer to it", async () => {
    const channels = new RunChannels();
    channels.open("7-1", () => undefined, "issue-1");
    await answerLinearIntake({ ...panelDeps(), channels }, prompted("", true), { action: "stop" });
    expect(await channels.next("7-1", 0)).toEqual([{ type: "stop" }]);
    expect(linear.calls).toEqual([]);
  });

  it("answers a stop after the run already finished with one response, no error and no job", async () => {
    stores.agentSessions.record("session-1", "issue-1", "API-1");
    const event = prompted("", true);
    const result = await linearIntake(intakeDeps(), event);
    await answerLinearIntake({ ...panelDeps(), channels: new RunChannels() }, event, result);
    expect(result).toEqual({ action: "stop" });
    expect(linear.activities().map((call) => call.content)).toEqual([{ type: "response", body: PANEL_TEXT.nothingToStop }]);
    expect(stores.jobs.list({ limit: 10 })).toEqual([]);
  });

  it("says the message waits while a person holds the ticket in a terminal session", async () => {
    await answerLinearIntake(panelDeps(), prompted("hi"), { action: "wait_for_lease", jobId: 1 });
    expect(linear.activities().map((call) => call.content)).toEqual([{ type: "thought", body: PANEL_TEXT.waitForLease }]);
  });
});
