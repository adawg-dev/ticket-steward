import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Redactor } from "../../src/core/redact.js";
import type { ImplementResult } from "../../src/implement/result.js";
import { linearIntake } from "../../src/linear/intake.js";
import { logger } from "../../src/log.js";
import { answerLinearIntake, failureContent, implementFinish, linearSessionFor, mergeRequestOpened, PANEL_TEXT, steerText, stoppedResponse } from "../../src/linear/session.js";
import { RunChannels } from "../../src/run/channel.js";
import { STOPPED_JOB_ERROR } from "../../src/run/execute.js";
import { seedSettings, type Settings } from "../../src/settings/schema.js";
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

  it("fails an implement still queued when the stop comes, and answers once that it stopped", async () => {
    const delegation = created();
    const { jobId } = await linearIntake(intakeDeps(), delegation);
    const stop = prompted("", true);
    const channels = new RunChannels();
    await answerLinearIntake({ ...panelDeps(), channels }, stop, await linearIntake(intakeDeps(), stop));
    expect(stores.jobs.get(jobId ?? 0)).toMatchObject({ status: "failed", error: STOPPED_JOB_ERROR });
    expect(stores.jobs.claimNext()).toBeNull();
    expect(linear.activities().map((call) => call.content).at(-1)).toEqual(stoppedResponse(null, null));
    expect(linear.activities().map((call) => call.content)).not.toContainEqual({ type: "response", body: PANEL_TEXT.nothingToStop });
    // Nothing is held for it: the job never opens a run.
    channels.open(`${jobId ?? 0}-1`, () => undefined, "issue-1", jobId ?? 0);
    expect(await channels.next(`${jobId ?? 0}-1`, 0)).toEqual([]);
  });

  it("holds a stop for an implement claimed but not yet running its brain, and leaves the answer to its run", async () => {
    const delegation = created();
    const { jobId } = await linearIntake(intakeDeps(), delegation);
    expect(stores.jobs.claimNext()?.id).toBe(jobId);
    const channels = new RunChannels();
    const stop = prompted("", true);
    await answerLinearIntake({ ...panelDeps(), channels }, stop, await linearIntake(intakeDeps(), stop));
    expect(stores.jobs.get(jobId ?? 0)?.status).toBe("running");
    expect(linear.activities().map((call) => call.content.type)).not.toContain("response");
    // The executor opens the run's channel: the brain takes the stop as soon as it starts.
    channels.open(`${jobId ?? 0}-1`, () => undefined, "issue-1", jobId ?? 0);
    expect(await channels.next(`${jobId ?? 0}-1`, 0)).toEqual([{ type: "stop" }]);
  });

  it("stops the open run and fails the chat queued behind it, leaving the one answer to the run", async () => {
    const channels = new RunChannels();
    channels.open("7-1", () => undefined, "issue-1", 7);
    const chatId = stores.jobs.enqueue({ kind: "linear", run: "chat", ...ticket, sessionId: "session-1", message: "and the docs?", author: "Ada" });
    await answerLinearIntake({ ...panelDeps(), channels }, prompted("", true), { action: "stop" });
    expect(await channels.next("7-1", 0)).toEqual([{ type: "stop" }]);
    expect(stores.jobs.get(chatId)).toMatchObject({ status: "failed", error: STOPPED_JOB_ERROR });
    expect(linear.calls).toEqual([]);
  });

  it("holds a stop for a queued fix, whose run hands its loop back, instead of failing it", async () => {
    const fixId = stores.jobs.enqueue({ kind: "loop", step: "fix", loopId: 3, ...ticket });
    const channels = new RunChannels();
    await answerLinearIntake({ ...panelDeps(), channels }, prompted("", true), { action: "stop" });
    expect(stores.jobs.get(fixId)?.status).toBe("queued");
    expect(linear.calls).toEqual([]);
    channels.open(`${fixId}-1`, () => undefined, "issue-1", fixId);
    expect(await channels.next(`${fixId}-1`, 0)).toEqual([{ type: "stop" }]);
  });

  it("says the message waits while a person holds the ticket in a terminal session", async () => {
    await answerLinearIntake(panelDeps(), prompted("hi"), { action: "wait_for_lease", jobId: 1 });
    expect(linear.activities().map((call) => call.content)).toEqual([{ type: "thought", body: PANEL_TEXT.waitForLease }]);
  });
});

describe("workflow-state moves", () => {
  const withSettings = (patch: Partial<Settings>) => ({ ...panelDeps(), settings: { get: () => ({ ...seedSettings(makeConfig()), ...patch }) } });
  const intakeDeps = () => ({ config: makeConfig(), stores, settings: { get: () => seedSettings(makeConfig()) } });
  const states = () => linear.calls.filter((call) => call.kind === "state");

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("moves a delegated ticket to its team's started state", async () => {
    const event = created();
    await answerLinearIntake(panelDeps(), event, await linearIntake(intakeDeps(), event));
    expect(states()).toEqual([{ kind: "state", issueId: "issue-1", which: { type: "started" } }]);
  });

  it("leaves the state alone with linear.moveToStarted off", async () => {
    const event = created();
    await answerLinearIntake(withSettings({ "linear.moveToStarted": false }), event, await linearIntake(intakeDeps(), event));
    expect(states()).toEqual([]);
    expect(linear.activities()).toHaveLength(1);
  });

  it("moves a ticket to the review state once its MR is open, and links the MR", async () => {
    stores.agentSessions.record("session-1", "issue-1", "API-1");
    await mergeRequestOpened(withSettings({ "linear.reviewStateName": "Code Review" }), "issue-1", "https://gitlab.example/mr/7");
    expect(linear.calls).toEqual([
      { kind: "urls", sessionId: "session-1", urls: [{ label: "Merge request", url: "https://gitlab.example/mr/7" }] },
      { kind: "state", issueId: "issue-1", which: { name: "Code Review" } },
    ]);
  });

  it("logs a missing review state once and says in the panel that it was not found", async () => {
    const warn = vi.spyOn(logger, "warn");
    stores.agentSessions.record("session-1", "issue-1", "API-1");
    stores.agentSessions.record("session-2", "issue-2", "API-2");
    linear.stateAnswer = "missing";

    await mergeRequestOpened(panelDeps(), "issue-1", "https://gitlab.example/mr/7");
    await mergeRequestOpened(panelDeps(), "issue-2", "https://gitlab.example/mr/8");

    expect(warn.mock.calls.filter(([, message]) => typeof message === "string" && message.includes("no such workflow state"))).toHaveLength(1);
    expect(linear.activities().map((call) => [call.sessionId, call.content])).toEqual([
      ["session-1", { type: "thought", body: 'I could not move the ticket to "In Review": its team has no workflow state by that name.' }],
      ["session-2", { type: "thought", body: 'I could not move the ticket to "In Review": its team has no workflow state by that name.' }],
    ]);
  });

  it("leaves a ticket with no agent session where it is", async () => {
    await mergeRequestOpened(panelDeps(), "issue-1", "https://gitlab.example/mr/7");
    expect(linear.calls).toEqual([]);
  });
});
