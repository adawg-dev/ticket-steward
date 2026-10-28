import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { BrainInput, BrainRun } from "../../src/brain/types.js";
import { latestSession } from "../../src/chat/session.js";
import { CHAT_MARKER } from "../../src/chat/result.js";
import { runChat } from "../../src/chat/run.js";
import type { StewardConfig } from "../../src/config/schema.js";
import type { PipelineDeps } from "../../src/core/deps.js";
import { Redactor } from "../../src/core/redact.js";
import type { RunContext } from "../../src/core/types.js";
import { storeLedger } from "../../src/push/ledger.js";
import { pushFromWorktree, type PushResult } from "../../src/push/service.js";
import { PushTargetSchema, type PushTarget } from "../../src/push/target.js";
import { openStores, type Stores } from "../../src/store/index.js";
import type { TicketBundle, TriggerEvent } from "../../src/tracker/types.js";
import { FakeBrain, type FakeBrainOptions } from "../fakes/fakeBrain.js";
import { FakeCodeHost } from "../fakes/fakeCodeHost.js";
import { FakeGitLabMr, fakeMergeRequest } from "../fakes/fakeGitLabMr.js";
import { FakeTracker } from "../fakes/fakeTracker.js";
import { freeTcpPort, tmpRepo, type TmpRepo } from "../fakes/tmpRepo.js";
import { commitFile, git } from "../workspace/helpers.js";

const IMPLEMENT_PROMPT = fileURLToPath(new URL("../../prompts/implement.md", import.meta.url));
const LABELS = { implement: "ready-for-agent", needsInfo: "needs-info", readyForHuman: "ready-for-human", implemented: "agent-implemented", approved: "agent-approved" };
const BRANCH = "fix/API-1-adapter-drops-the-last-chunk";
const DISCUSSION = "disc-1";

const issue: TicketBundle = {
  id: "issue-1",
  identifier: "API-1",
  url: "https://linear.app/acme/issue/API-1",
  title: "Adapter drops the last chunk",
  description: "The adapter loses the final chunk.",
  team: { id: "team-1", key: "API", name: "API" },
  state: { name: "In Review", type: "started" },
  labels: ["agent-implemented"],
  priority: 2,
  creator: { name: "Ada", isBot: false },
  createdAt: "2026-10-27T00:00:00.000Z",
  comments: [],
  attachments: [],
  appliedTemplate: null,
  templates: [],
};

let repo: TmpRepo;
let stores: Stores;
let tracker: FakeTracker;
let gitlab: FakeGitLabMr;
let port: number;
let baseSha: string;
let headSha: string;

const makeConfig = (): StewardConfig => ({
  dataDir: repo.dataDir,
  brain: { kind: "claude-code", model: "claude-test", maxTurns: 5, timeoutMinutes: 1 },
  tracker: { kind: "linear", teams: ["API"], labels: LABELS },
  codehost: { kind: "gitlab", baseUrl: "https://gitlab.example", project: "acme/repo" },
  workspace: { fetchUrl: repo.repo, baseBranch: "main", overlayDir: repo.overlayDir, setup: [], setupTimeoutMinutes: 1, port, keepOnFailure: false },
  retention: { keptWorktrees: 3, days: 30 },
  server: { port: 3020, publicUrl: "https://steward.example" },
  implement: {
    prompt: IMPLEMENT_PROMPT,
    branchTypes: ["feature", "fix", "chore", "refactor"],
    checks: [],
    checksTimeoutMinutes: 1,
    commitAuthor: { name: "Ticket Steward", email: "steward@example.com" },
    timeoutMinutes: 2,
    maxTurns: 7,
    protectedBranches: ["main"],
  },
  chat: { prefix: "/agent", sessionRetentionDays: 180 },
});

const pushTargetOf = (input: BrainInput): PushTarget | null => {
  const spec = input.mcpServers.push;
  const args = spec?.type === "http" ? undefined : spec?.args;
  if (args === undefined) return null;
  return PushTargetSchema.parse(JSON.parse(args[args.indexOf("--target") + 1] ?? "null"));
};

type AgentStep = (workspace: string, push: () => Promise<PushResult>) => Promise<void>;

/** A brain that acts like the agent: `act` edits the worktree and may call the real push service with the run's target. */
class AgentBrain extends FakeBrain {
  deps: PipelineDeps | null = null;
  readonly pushes: PushResult[] = [];

  constructor(options: FakeBrainOptions, private readonly act: AgentStep) {
    super(options);
  }

  override async run(input: BrainInput, onMessage: (line: string) => void): Promise<BrainRun> {
    const run = await super.run(input, onMessage);
    const target = pushTargetOf(input);
    await this.act(input.workspacePath, async () => {
      if (target === null || this.deps === null) throw new Error("the run has no push tool");
      const pushed = await pushFromWorktree({ deps: { ...this.deps, ledger: storeLedger(this.deps) }, target, branchType: null }).catch((err: unknown): PushResult => ({ ok: false, reason: "push failed", detail: String(err) }));
      this.pushes.push(pushed);
      return pushed;
    });
    return run;
  }
}

const makeDeps = (brain: FakeBrain): PipelineDeps => {
  const deps: PipelineDeps = {
    config: makeConfig(),
    secrets: { GITLAB_PUSH_TOKEN: "glpat-push-token-value" },
    configPath: join(repo.root, "steward.config.ts"),
    binPath: join(repo.root, "bin", "steward.js"),
    tracker,
    brain,
    codehost: new FakeCodeHost(),
    gitlab,
    mirror: repo.mirror,
    stores,
    redactor: new Redactor([]),
    now: () => new Date("2026-10-28T12:00:00.000Z"),
    runBrain: (_config, input) => brain.run(input, () => undefined),
  };
  if (brain instanceof AgentBrain) brain.deps = deps;
  return deps;
};

const commitAndPush: AgentStep = async (workspace, push) => {
  await mkdir(join(workspace, "src"), { recursive: true });
  await writeFile(join(workspace, "src", "adapter.ts"), "export const adapter = 3;\n");
  await git(workspace, ["add", "--", "src/adapter.ts"]);
  await git(workspace, ["commit", "-q", "-m", "API-1: Keep the retry"]);
  await push();
};

/** The implement job that pushed BRANCH at `headSha` from `baseSha`, leaving `session-impl` in worktree `name`. */
const implementJob = (opts: { pushed: boolean; name?: string }): number => {
  const jobId = stores.jobs.enqueue({ kind: "cli", issueId: "issue-1", identifier: "API-1", teamKey: "API", action: "implement" });
  stores.jobs.claimById(jobId);
  stores.jobs.recordWorkspace(jobId, opts.name ?? `${jobId}-1`, baseSha);
  stores.jobs.recordSession(jobId, "session-impl");
  if (opts.pushed) {
    stores.jobs.recordCommit(jobId, BRANCH, headSha);
    stores.jobs.markPushed(jobId);
    // The implement push went through the push tool, so its push row is the branch's head.
    const pushId = stores.pushes.record({ jobId, loopId: null, branch: BRANCH, sha: headSha, previousSha: null, note: null });
    stores.pushes.markPushed(pushId);
  }
  stores.jobs.finish(jobId, { status: "succeeded" });
  return jobId;
};

const createLoop = (state: "awaiting_review" | "handed_back" = "awaiting_review"): number => {
  const jobId = implementJob({ pushed: true });
  const id = stores.loops.create({
    issueId: "issue-1", identifier: "API-1", teamKey: "API", implementJobId: jobId, branch: BRANCH, baseSha, headSha,
    worktreeName: "ticket-API-1", labelDriven: true, sessionId: "session-1",
  });
  stores.loops.update(id, { projectId: 42, mrIid: 7, mrUrl: gitlab.mr.webUrl, state });
  return id;
};

const claim = (loopId: number | null, message = "why did you drop the retry?"): RunContext => {
  const trigger: TriggerEvent = {
    kind: "chat", issueId: "issue-1", identifier: "API-1", teamKey: "API", loopId, projectId: 42, mrIid: 7,
    discussionId: DISCUSSION, noteId: 501, author: "ada", message,
  };
  const jobId = stores.jobs.enqueue(trigger);
  stores.jobs.claimById(jobId);
  const attempt = stores.attempts.start(jobId);
  return { jobId, attempt: attempt.number, issueId: "issue-1", identifier: "API-1", teamKey: "API", trigger, dryRun: false };
};

beforeEach(async () => {
  repo = await tmpRepo("unused");
  await commitFile(repo.repo, ".gitignore", ".env\n");
  baseSha = await git(repo.repo, ["rev-parse", "main"]);
  await git(repo.repo, ["checkout", "-q", "-b", BRANCH]);
  headSha = await commitFile(repo.repo, "src/adapter.ts", "export const adapter = 2;\n");
  await git(repo.repo, ["checkout", "-q", "main"]);
  await repo.mirror.fetch();
  stores = openStores(repo.dataDir);
  tracker = new FakeTracker([structuredClone(issue)]);
  gitlab = new FakeGitLabMr(fakeMergeRequest({ sha: headSha, sourceBranch: BRANCH }));
  port = await freeTcpPort();
});

afterEach(async () => {
  stores.db.close();
  await repo.cleanup();
});

describe("runChat", () => {
  it("resumes the loop's session in its recreated worktree and posts the reply with the marker in the note's discussion", async () => {
    const loopId = createLoop();
    const brain = new FakeBrain({ result: { reply: "The retry hid the error; I removed it on purpose." }, sessionId: "session-2" });
    const ctx = claim(loopId);

    const outcome = await runChat(ctx, makeDeps(brain));

    expect(outcome).toEqual({ status: "succeeded" });
    const input = brain.lastInput();
    expect(input.resumeSessionId).toBe("session-1");
    expect(input.output).toBe("chat");
    expect(input.workspacePath).toBe(join(repo.dataDir, "work", "ticket-API-1"));
    expect(input.prompt).toContain("why did you drop the retry?");
    expect(input.prompt).toContain("ada");
    expect(input.prompt).toContain(gitlab.mr.webUrl);
    expect(input.prompt).toContain("Call the `push` tool");
    expect(await git(input.workspacePath, ["rev-parse", "HEAD"])).toBe(headSha);
    expect(pushTargetOf(input)).toMatchObject({ jobId: ctx.jobId, mode: "fastForward", branch: BRANCH, baseSha, loopId, identifier: "API-1", issueId: "issue-1" });
    expect(gitlab.replies).toEqual([{ discussionId: DISCUSSION, body: `The retry hid the error; I removed it on purpose.\n\n${CHAT_MARKER}` }]);
    expect(stores.loops.get(loopId)?.sessionId).toBe("session-2");
    expect(stores.jobs.get(ctx.jobId)?.sessionId).toBe("session-2");
    expect(stores.jobs.get(ctx.jobId)?.chatResult).toEqual({ reply: "The retry hid the error; I removed it on purpose.", warning: null });
  });

  it("keeps the worktree after the run: it is the session's", async () => {
    const loopId = createLoop();
    const brain = new FakeBrain({ result: { reply: "ok" } });

    await runChat(claim(loopId), makeDeps(brain));

    expect(await git(join(repo.dataDir, "work", "ticket-API-1"), ["rev-parse", "HEAD"])).toBe(headSha);
  });

  it("a push through the tool moves the loop's head, so the loop reads it as its own", async () => {
    const loopId = createLoop();
    const brain = new AgentBrain({ result: { reply: "Put the retry back." } }, commitAndPush);

    const outcome = await runChat(claim(loopId), makeDeps(brain));

    expect(outcome).toEqual({ status: "succeeded" });
    const pushed = await git(repo.repo, ["rev-parse", BRANCH]);
    expect(await git(repo.repo, ["rev-parse", `${pushed}^`])).toBe(headSha);
    expect(brain.pushes).toEqual([{ ok: true, branch: BRANCH, sha: pushed, commits: 1 }]);
    expect(stores.loops.get(loopId)).toMatchObject({ headSha: pushed, state: "awaiting_review" });
    expect(gitlab.replies[0]?.body).toBe(`Put the retry back.\n\n${CHAT_MARKER}`);
  });

  it("without a loop, pushes onto the implement job's branch head and records it there for the next chat", async () => {
    const jobId = implementJob({ pushed: true });
    const brain = new AgentBrain({ result: { reply: "Done." }, sessionId: "session-impl-2" }, commitAndPush);

    const outcome = await runChat(claim(null), makeDeps(brain));

    expect(outcome).toEqual({ status: "succeeded" });
    const pushed = await git(repo.repo, ["rev-parse", BRANCH]);
    expect(await git(repo.repo, ["rev-parse", `${pushed}^`])).toBe(headSha);
    expect(pushTargetOf(brain.lastInput())).toMatchObject({ jobId, loopId: null, branch: BRANCH, baseSha });
    expect(latestSession(stores, "issue-1")).toMatchObject({ sessionId: "session-impl-2", headSha: pushed, branch: BRANCH, jobId });
  });

  it("answers only, with no push tool, when the ticket has no pushed branch", async () => {
    implementJob({ pushed: false });
    const brain = new FakeBrain({ result: { reply: "It needs the implement label." } });

    const outcome = await runChat(claim(null), makeDeps(brain));

    expect(outcome).toEqual({ status: "succeeded" });
    expect(brain.lastInput().mcpServers.push).toBeUndefined();
    expect(brain.lastInput().prompt).toContain("code changes need the ticket's implement label");
    expect(await git(brain.lastInput().workspacePath, ["rev-parse", "HEAD"])).toBe(baseSha);
    expect(gitlab.replies[0]?.body).toBe(`It needs the implement label.\n\n${CHAT_MARKER}`);
  });

  it("says in the reply what the agent left unpushed, and never pushes it", async () => {
    const loopId = createLoop();
    const brain = new FakeBrain({ result: { reply: "Started on it." }, editWorkspace: { "src/new.ts": "export {};\n" } });

    const outcome = await runChat(claim(loopId), makeDeps(brain));

    expect(outcome).toEqual({ status: "succeeded", warning: "the agent left unpushed work" });
    expect(gitlab.replies[0]?.body).toContain("Started on it.\n\nLeft in the agent's worktree, not pushed:");
    expect(gitlab.replies[0]?.body).toContain("src/new.ts");
    expect(gitlab.replies[0]?.body.endsWith(CHAT_MARKER)).toBe(true);
    expect(await git(repo.repo, ["rev-parse", BRANCH])).toBe(headSha);
  });

  it("posts a short failure reply when the brain fails, and finishes with a warning", async () => {
    const loopId = createLoop();
    const brain = new FakeBrain({ fail: true, error: "max turns" });

    const outcome = await runChat(claim(loopId), makeDeps(brain));

    expect(outcome).toEqual({ status: "succeeded", warning: "the agent's run failed: max turns" });
    expect(gitlab.replies[0]?.body).toBe(`The agent could not answer: its run failed.\n\n${CHAT_MARKER}`);
  });

  it("a retry after the reply was stored posts it without running the brain again", async () => {
    const loopId = createLoop();
    const ctx = claim(loopId);
    stores.jobs.saveChatResult(ctx.jobId, { reply: "Stored answer.", warning: null });
    const brain = new FakeBrain({ result: { reply: "a second answer" } });

    const outcome = await runChat(ctx, makeDeps(brain));

    expect(outcome).toEqual({ status: "succeeded" });
    expect(brain.runs).toBe(0);
    expect(gitlab.replies).toEqual([{ discussionId: DISCUSSION, body: `Stored answer.\n\n${CHAT_MARKER}` }]);
  });

  it("a reply GitLab refuses is a publish failure, and the stored reply is posted on the retry", async () => {
    const loopId = createLoop();
    const ctx = claim(loopId);
    const brain = new FakeBrain({ result: { reply: "Answer." } });
    const deps = makeDeps(brain);
    gitlab.failNextReply();

    expect(await runChat(ctx, deps)).toEqual({ status: "publish_failed", error: "chat reply: GitLab down" });
    expect(await runChat(ctx, deps)).toEqual({ status: "succeeded" });
    expect(brain.runs).toBe(1);
    expect(gitlab.replies.map((reply) => reply.body)).toEqual([`Answer.\n\n${CHAT_MARKER}`]);
  });
});
