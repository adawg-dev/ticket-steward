import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { noteIntake, type NoteIntakeDeps } from "../../src/chat/intake.js";
import type { GitlabNote, GitlabWakeEvent } from "../../src/codehost/gitlabWebhook.js";
import type { StewardConfig } from "../../src/config/schema.js";
import { RunChannels } from "../../src/run/channel.js";
import { seedSettings } from "../../src/settings/schema.js";
import { loopSubject, openStores, type LoopState, type Stores } from "../../src/store/index.js";
import { FakeGitLabMr } from "../fakes/fakeGitLabMr.js";

const BRANCH = "fix/API-1-keep";
const DEVELOPER = 5;
const REPORTER = 6;
const T0 = Date.parse("2026-10-29T10:00:00.000Z");
const QUIET_MS = 2 * 60_000;

let dataDir: string;
let stores: Stores;
let gitlab: FakeGitLabMr;
let channels: RunChannels;
let now: Date;
let noteIds = 100;

const config = (): StewardConfig => ({
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
  greptile: {
    botUsername: "greptile-bot", maxRounds: 5, prompt: "/dev/null", pollSeconds: 300, mrTimeoutMinutes: 30,
    reviewTimeoutMinutes: 30, pipelineTimeoutMinutes: 30, ciLogLines: 200,
  },
  chat: { prefix: "/agent", sessionRetentionDays: 180 },
});

const deps = (): NoteIntakeDeps => {
  const steward = config();
  return { config: steward, stores, gitlab, channels, settings: { get: () => seedSettings(steward) }, now: () => now };
};

const intake = (body: string, over: Partial<GitlabNote> = {}, at: Partial<GitlabWakeEvent> = {}) => {
  const note: GitlabNote = {
    id: noteIds++, authorId: DEVELOPER, authorUsername: "ada", authorIsBot: false, body, discussionId: "disc-1", system: false, ...over,
  };
  const event: GitlabWakeEvent = { kind: "note", projectId: 42, projectPath: "acme/repo", branch: BRANCH, mrIid: 7, ...at, note };
  return noteIntake(deps(), event, note);
};

/** A loop on BRANCH in `state`; an awaiting loop has its await job deferred five minutes out, as after a poll. */
const loopIn = (state: LoopState): { loopId: number; awaitId: number | null } => {
  const implementJobId = stores.jobs.enqueue({ kind: "cli", issueId: "issue-1", identifier: "API-1", teamKey: "API", action: "implement" });
  stores.jobs.claimById(implementJobId);
  stores.jobs.finish(implementJobId, { status: "succeeded" });
  const loopId = stores.loops.create({
    issueId: "issue-1", identifier: "API-1", teamKey: "API", implementJobId, branch: BRANCH, baseSha: "b".repeat(40),
    headSha: "h".repeat(40), worktreeName: "ticket-API-1", labelDriven: true, sessionId: "session-1",
  });
  stores.loops.update(loopId, { state, projectId: 42, mrIid: 7 });
  if (state !== "awaiting_review") return { loopId, awaitId: null };
  const awaitId = stores.jobs.enqueue({ kind: "loop", issueId: "issue-1", identifier: "API-1", teamKey: "API", loopId, step: "await" });
  stores.jobs.claimById(awaitId);
  stores.jobs.defer(awaitId, new Date(now.getTime() + 300_000));
  return { loopId, awaitId };
};

const queued = () => stores.jobs.list({ status: "queued", limit: 50 });

beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "steward-note-intake-"));
  stores = openStores(dataDir);
  gitlab = new FakeGitLabMr();
  gitlab.members.set(DEVELOPER, 30);
  gitlab.members.set(REPORTER, 20);
  channels = new RunChannels();
  now = new Date(T0);
});

afterEach(async () => {
  stores.db.close();
  await rm(dataDir, { recursive: true, force: true });
});

describe("noteIntake", () => {
  it("batches ten notes in 30 s into the one queued await, due a quiet window after the last", async () => {
    const { loopId, awaitId } = loopIn("awaiting_review");

    for (let i = 0; i < 10; i++) {
      now = new Date(T0 + i * 3_000);
      expect((await intake(`comment ${i}`)).action).toBe("queued_round");
    }

    expect(queued().map((job) => job.id)).toEqual([awaitId]);
    expect(stores.jobs.get(awaitId ?? 0)?.notBefore).toBe(new Date(T0 + 27_000 + QUIET_MS).toISOString());
    expect(stores.loops.get(loopId)?.pendingNotesSince).toBe(new Date(T0).toISOString());
  });

  it("never pushes the round past twice the quiet window after the batch's first note", async () => {
    const { awaitId } = loopIn("awaiting_review");

    for (let minute = 0; minute <= 5; minute++) {
      now = new Date(T0 + minute * 60_000);
      await intake(`still typing ${minute}`);
    }

    expect(stores.jobs.get(awaitId ?? 0)?.notBefore).toBe(new Date(T0 + 2 * QUIET_MS).toISOString());
  });

  it("ignores the steward's own notes and system notes", async () => {
    const { awaitId } = loopIn("awaiting_review");

    const steward = { authorUsername: "steward-bot", authorId: 3 };
    expect((await intake("Fixed in abc.\n\n<!-- ticket-steward:loop id=1 reply -->", steward)).action).toBe("ignored");
    expect((await intake("the agent says hi\n\n<!-- ticket-steward:chat -->", steward)).action).toBe("ignored");
    expect((await intake("/agent a note of its own", steward)).action).toBe("chat_ignored");
    expect((await intake("added 1 commit", { system: true })).action).toBe("ignored");

    expect(stores.jobs.get(awaitId ?? 0)?.notBefore).toBe(new Date(T0 + 300_000).toISOString());
  });

  it("takes the steward's marker on anyone else's note for nothing: the note wakes the loop like any other", async () => {
    const { awaitId } = loopIn("awaiting_review");

    expect((await intake("Please keep v1\n\n<!-- ticket-steward:loop id=1 reply -->")).action).toBe("queued_round");
    expect(stores.jobs.get(awaitId ?? 0)?.notBefore).toBe(new Date(T0 + QUIET_MS).toISOString());
    expect((await intake("Sneaky\n\n<!-- ticket-steward:chat -->", { authorId: 77, authorUsername: "mallory" })).action).toBe("denied");
  });

  it("denies a bot that is not a Developer on the project, by name or by GitLab's flag, and listens to one that is", async () => {
    const { loopId } = loopIn("passed");

    expect((await intake("Run this", { authorUsername: "project_99_bot_ab12", authorId: 77, authorIsBot: true })).action).toBe("denied");
    expect((await intake("Run this", { authorUsername: "service-account", authorId: 78, authorIsBot: true })).action).toBe("denied");
    expect(stores.loops.get(loopId)?.state).toBe("passed");
    expect(queued()).toEqual([]);

    gitlab.members.set(79, 30);
    expect((await intake("Coverage dropped", { authorUsername: "project_42_bot_cd34", authorId: 79, authorIsBot: true })).action).toBe("queued_round");
  });

  it("ignores a note on another MR from a branch of the same name, or on a fork's MR", async () => {
    const { awaitId } = loopIn("awaiting_review");

    expect((await intake("from MR 8", {}, { mrIid: 8 })).action).toBe("ignored");
    expect((await intake("/agent from MR 8", {}, { mrIid: 8 })).action).toBe("chat_no_session");
    expect((await intake("from a fork", {}, { sourceProjectId: 99 })).action).toBe("ignored");
    expect((await intake("/agent from a fork", {}, { sourceProjectId: 99 })).action).toBe("ignored");
    expect(stores.jobs.get(awaitId ?? 0)?.notBefore).toBe(new Date(T0 + 300_000).toISOString());
    expect(queued().map((job) => job.id)).toEqual([awaitId]);
  });

  it("queues a round for a Greptile note without asking GitLab for its access", async () => {
    const { awaitId } = loopIn("awaiting_review");

    const result = await intake("Consider a guard here.", { authorUsername: "greptile-bot", authorId: 999 });

    expect(result.action).toBe("queued_round");
    expect(stores.jobs.get(awaitId ?? 0)?.notBefore).toBe(new Date(T0 + QUIET_MS).toISOString());
  });

  it("steers the running fix with the note instead of queuing a job", async () => {
    const { loopId } = loopIn("fixing");
    const fixId = stores.jobs.enqueue({ kind: "loop", issueId: "issue-1", identifier: "API-1", teamKey: "API", loopId, step: "fix" });
    stores.jobs.claimById(fixId);
    channels.open("run-1", () => undefined, "issue-1", fixId);

    const result = await intake("Please also rename the helper.");

    expect(result).toEqual({ action: "steered", loopId });
    expect(await channels.next("run-1", 0)).toEqual([
      { type: "steer", message: "New comment from ada on the MR (answer it in the next round, not now):\nPlease also rename the helper." },
    ]);
    expect(queued()).toEqual([]);
  });

  it("steers a chat running on a passed loop with the note, and opens the loop again so a round answers it", async () => {
    const { loopId } = loopIn("passed");
    const chatId = stores.jobs.enqueue({ kind: "linear", run: "chat", issueId: "issue-1", identifier: "API-1", teamKey: "API", sessionId: "s", message: "hi" });
    stores.jobs.claimById(chatId);
    channels.open(`${chatId}-1`, () => undefined, "issue-1", chatId);

    expect((await intake("And rename the flag")).action).toBe("steered");

    expect(await channels.next(`${chatId}-1`, 0)).toEqual([{ type: "steer", message: expect.stringContaining("And rename the flag") }]);
    expect(stores.loops.get(loopId)?.state).toBe("awaiting_review");
    expect(queued()).toEqual([expect.objectContaining({ kind: "await_review", subject: loopSubject(loopId), notBefore: new Date(T0 + QUIET_MS).toISOString() })]);
  });

  it("leaves a queued fix to answer the note in its round", async () => {
    const { loopId } = loopIn("fixing");
    stores.jobs.enqueue({ kind: "loop", issueId: "issue-1", identifier: "API-1", teamKey: "API", loopId, step: "fix" });

    expect((await intake("one more thing")).action).toBe("queued_round");
    expect(queued().map((job) => job.kind)).toEqual(["fix"]);
  });

  it("denies a Reporter and a non-member", async () => {
    const { awaitId } = loopIn("awaiting_review");

    expect((await intake("looks off", { authorId: REPORTER })).action).toBe("denied");
    expect((await intake("looks off", { authorId: 77 })).action).toBe("denied");
    expect(stores.jobs.get(awaitId ?? 0)?.notBefore).toBe(new Date(T0 + 300_000).toISOString());
  });

  it("ignores notes on an unassigned or stopped loop", async () => {
    loopIn("unassigned");
    expect((await intake("please continue")).action).toBe("ignored");
    stores.loops.update(stores.loops.latestForBranch(BRANCH)?.id ?? 0, { state: "stopped" });
    expect((await intake("please continue")).action).toBe("ignored");
    expect(queued()).toEqual([]);
  });

  it("opens a passed loop again for a new note, with its await due after the quiet window", async () => {
    const { loopId } = loopIn("passed");

    expect((await intake("one more question")).action).toBe("queued_round");

    expect(stores.loops.get(loopId)).toMatchObject({ state: "awaiting_review", endedAt: null, pendingNotesSince: new Date(T0).toISOString() });
    const [job] = queued();
    expect(job).toMatchObject({ kind: "await_review", subject: loopSubject(loopId), notBefore: new Date(T0 + QUIET_MS).toISOString() });
  });

  it("restarts a handed-back loop for a person's note, but not for a bot's", async () => {
    const { loopId } = loopIn("handed_back");

    expect((await intake("Bot finding", { authorUsername: "greptile-bot", authorId: 999 })).action).toBe("ignored");
    expect(queued()).toEqual([]);

    expect((await intake("I pushed a fix; carry on.")).action).toBe("queued_round");
    expect(queued().map((job) => job.trigger)).toEqual([
      { kind: "loop", issueId: "issue-1", identifier: "API-1", teamKey: "API", loopId, step: "restart" },
    ]);
  });

  it("keeps `/agent` notes on the chat path", async () => {
    loopIn("awaiting_review");

    expect((await intake("/agent why this?")).action).toBe("chat");
    expect(queued().map((job) => job.kind).sort()).toEqual(["await_review", "chat"]);
  });

  it("ignores a note on a branch with no loop", async () => {
    expect((await intake("hello")).action).toBe("ignored");
    expect(queued()).toEqual([]);
  });
});
