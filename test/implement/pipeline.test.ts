import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { BrainInput, BrainRun } from "../../src/brain/types.js";
import type { StewardConfig } from "../../src/config/schema.js";
import type { PipelineDeps } from "../../src/core/deps.js";
import { Redactor } from "../../src/core/redact.js";
import type { RunContext } from "../../src/core/types.js";
import type { ImplementResult } from "../../src/implement/result.js";
import { publishImplementOnly, runImplement } from "../../src/implement/pipeline.js";
import { storeLedger } from "../../src/push/ledger.js";
import { pushFromWorktree, type PushResult } from "../../src/push/service.js";
import { PushTargetSchema, type PushTarget } from "../../src/push/target.js";
import { RunChannels } from "../../src/run/channel.js";
import { STOPPED_JOB_ERROR } from "../../src/run/execute.js";
import type { RunExecutor } from "../../src/run/executor.js";
import { localExecutor } from "../../src/run/local.js";
import { RunSpecSchema, type RunReport, type RunSpec } from "../../src/run/protocol.js";
import { openStores, type Stores } from "../../src/store/index.js";
import type { TriggerEvent, TicketBundle } from "../../src/tracker/types.js";
import { SlotClient } from "../../src/workspace/slots.js";
import { fakeSlotRunner } from "../fakes/fakeSlotRunner.js";
import { FakeBrain } from "../fakes/fakeBrain.js";
import { FakeCodeHost } from "../fakes/fakeCodeHost.js";
import { FakeGitLabMr } from "../fakes/fakeGitLabMr.js";
import { RecordingLinear } from "../fakes/fakeLinearAgent.js";
import { FakeTracker } from "../fakes/fakeTracker.js";
import { freeTcpPort, tmpRepo, type TmpRepo } from "../fakes/tmpRepo.js";
import { commitFile, git } from "../workspace/helpers.js";

const IMPLEMENT_PROMPT = fileURLToPath(new URL("../../prompts/implement.md", import.meta.url));

const issue: TicketBundle = {
  id: "issue-1",
  identifier: "API-1",
  url: "https://linear.app/acme/issue/API-1",
  title: "Adapter drops the last chunk",
  description: "The adapter loses the final chunk.",
  team: { id: "team-1", key: "API", name: "API" },
  state: { name: "Todo", type: "unstarted" },
  labels: ["ready-for-agent"],
  priority: 2,
  creator: { name: "Ada", isBot: false },
  createdAt: "2026-09-11T00:00:00.000Z",
  comments: [],
  attachments: [],
  appliedTemplate: null,
  templates: [],
};

const trigger: TriggerEvent = { kind: "linear", run: "implement", issueId: "issue-1", identifier: "API-1", teamKey: "API", sessionId: "session-1", message: null };

const BRANCH = "fix/API-1-adapter-drops-the-last-chunk";
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);

const implemented: ImplementResult = {
  outcome: "implemented",
  summary: "Flush the buffer before closing the stream.",
  reviewNotes: ["Check the streaming test."],
  checksRun: ["tsc: ok"],
  questions: [],
  failureDetail: null,
  media: [],
};

let repo: TmpRepo;
let stores: Stores;
let tracker: FakeTracker;
let port: number;

const makeConfig = (implement: Partial<NonNullable<StewardConfig["implement"]>> = {}): StewardConfig => ({
  dataDir: repo.dataDir,
  brain: { kind: "claude-code", model: "claude-test", maxTurns: 5, timeoutMinutes: 1 },
  tracker: { kind: "linear", teams: ["API"] },
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
    timeoutMinutes: 1,
    maxTurns: 5,
    protectedBranches: ["main"],
    ...implement,
  },
});

/** The push target the steward gave the run's push server, read back from its command line. */
const pushTargetOf = (input: BrainInput): PushTarget | null => {
  const spec = input.mcpServers.push;
  const args = spec?.type === "http" ? undefined : spec?.args;
  if (args === undefined) return null;
  return PushTargetSchema.parse(JSON.parse(args[args.indexOf("--target") + 1] ?? "null"));
};

/** The agent's commit in its worktree. */
const agentCommit = async (workspace: string, subject: string, file = "src/adapter.ts", content = "export const adapter = 2;\n"): Promise<string> => {
  await mkdir(join(workspace, file, ".."), { recursive: true });
  await writeFile(join(workspace, file), content);
  await git(workspace, ["add", "--", file]);
  await git(workspace, ["commit", "-q", "-m", subject]);
  return git(workspace, ["rev-parse", "HEAD"]);
};

type AgentStep = (workspace: string, push: (branchType?: string | null) => Promise<PushResult>) => Promise<void>;

/** Commits the adapter fix and pushes it as a `fix` branch, as the prompt asks. */
const commitAndPush: AgentStep = async (workspace, push) => {
  await agentCommit(workspace, "API-1: Keep the last chunk");
  await push("fix");
};

/** As `commitAndPush`, then Linear fails the publish step's ticket read. */
const pushThenLinearDown: AgentStep = async (workspace, push) => {
  await commitAndPush(workspace, push);
  tracker.failNextRead();
};

/**
 * A brain that acts like the agent: `act` edits and commits in the worktree and calls the push tool, here the real push
 * service with the target the steward put on the push server's command line. Returns `result`.
 */
const agentBrain = (result: unknown, act: AgentStep = commitAndPush) => {
  const calls: BrainInput[] = [];
  const pushes: PushResult[] = [];
  let deps: PipelineDeps | null = null;
  const runBrain = async (_config: unknown, input: BrainInput): Promise<BrainRun> => {
    calls.push(input);
    const target = pushTargetOf(input);
    await act(input.workspacePath, async (branchType = null) => {
      if (target === null || deps === null) throw new Error("the run has no push tool");
      // The MCP server turns a thrown error into a refusal; so does this stand-in.
      const pushed = await pushFromWorktree({ deps: { ...deps, ledger: storeLedger(deps) }, target, branchType }).catch((err: unknown): PushResult => ({ ok: false, reason: "push failed", detail: String(err) }));
      pushes.push(pushed);
      return pushed;
    });
    return { ok: true, output: result };
  };
  return {
    calls,
    pushes,
    runBrain,
    /** The push service runs with the job's own deps, as `steward mcp push` builds them from the same config. */
    bind: (bound: PipelineDeps): PipelineDeps => {
      deps = bound;
      return bound;
    },
  };
};

const makeDeps = (runBrain: PipelineDeps["runBrain"], config: StewardConfig = makeConfig()): PipelineDeps => ({
  config,
  secrets: { GITLAB_PUSH_TOKEN: "glpat-push-token-value" },
  configPath: join(repo.root, "steward.config.ts"),
  binPath: join(repo.root, "bin", "steward.js"),
  tracker,
  brain: new FakeBrain(),
  codehost: new FakeCodeHost(),
  mirror: repo.mirror,
  stores,
  redactor: new Redactor([]),
  now: () => new Date("2026-09-30T12:00:00.000Z"),
  ...(runBrain === undefined ? {} : { runBrain }),
});

/** The job's stored result and hand-back, where a hand-back's reason lives now that Linear gets no comments. */
const recorded = (jobId: number): string => JSON.stringify(stores.jobs.get(jobId)?.implementResult ?? null);

const claim = (event: TriggerEvent = trigger): RunContext => {
  const jobId = stores.jobs.enqueue(event);
  stores.jobs.claimById(jobId);
  stores.attempts.start(jobId);
  return { jobId, attempt: 1, issueId: event.issueId, identifier: event.identifier, teamKey: event.teamKey, trigger: event, dryRun: false };
};

beforeEach(async () => {
  repo = await tmpRepo("unused");
  await commitFile(repo.repo, ".gitignore", ".env\n");
  await repo.mirror.fetch();
  stores = openStores(repo.dataDir);
  tracker = new FakeTracker([issue]);
  port = await freeTcpPort();
});

afterEach(async () => {
  vi.restoreAllMocks();
  stores.db.close();
  await repo.cleanup();
});


type AgentBrain = ReturnType<typeof agentBrain>;

/** The job's deps with the agent's push tool bound to them. */
const depsFor = (brain: AgentBrain, config: StewardConfig = makeConfig()): PipelineDeps => brain.bind(makeDeps(brain.runBrain, config));

const remoteBranches = (): Promise<string> => git(repo.repo, ["branch", "--list", "*/API-1-*"]);

describe("runImplement", () => {
  it("succeeds once the agent pushed through the push tool, moving no labels", async () => {
    const brain = agentBrain(implemented);
    const ctx = claim();

    const outcome = await runImplement(ctx, depsFor(brain));

    expect(outcome).toEqual({ status: "succeeded" });
    expect(brain.pushes).toMatchObject([{ ok: true, branch: BRANCH, commits: 1 }]);
    const job = stores.jobs.get(ctx.jobId);
    expect(job?.branch).toBe(BRANCH);
    expect(await git(repo.repo, ["rev-parse", `refs/heads/${BRANCH}`])).toBe(job?.commitSha);
    expect(await git(repo.repo, ["log", "-1", "--format=%s", `refs/heads/${BRANCH}`])).toBe("API-1: Keep the last chunk");
    expect(job?.pushedAt).not.toBeNull();
    expect(job?.implementResult).toEqual({ result: implemented, handback: null, baseSha: await git(repo.repo, ["rev-parse", "main"]) });
    expect(tracker.labelsOf("issue-1")).toEqual(["ready-for-agent"]);
    expect(brain.calls[0]?.output).toBe("implement");
    expect(brain.calls[0]?.timeoutMs).toBe(60_000);
  });

  it("gives the run a push tool that creates the ticket branch on the job's base", async () => {
    const brain = agentBrain(implemented);
    const ctx = claim();

    await runImplement(ctx, depsFor(brain));

    const input = brain.calls[0];
    expect(input === undefined ? null : pushTargetOf(input)).toEqual({
      jobId: ctx.jobId, worktreePath: input?.workspacePath, identifier: "API-1", issueId: "issue-1", title: "Adapter drops the last chunk", mode: "create", branch: null,
      baseSha: await git(repo.repo, ["rev-parse", "main"]), loopId: null, port,
    });
  });

  it("keeps every commit of a series the agent pushed in two pushes", async () => {
    const brain = agentBrain(implemented, async (workspace, push) => {
      await agentCommit(workspace, "API-1: Keep the last chunk");
      await push("fix");
      await agentCommit(workspace, "API-1: Test it", "test/adapter.test.ts", "test\n");
      await push();
    });
    const ctx = claim();

    expect(await runImplement(ctx, depsFor(brain))).toEqual({ status: "succeeded" });

    expect(brain.pushes.map((pushed) => pushed.ok)).toEqual([true, true]);
    expect(await git(repo.repo, ["log", "--format=%s", `main..refs/heads/${BRANCH}`])).toBe("API-1: Test it\nAPI-1: Keep the last chunk");
    expect(await git(repo.repo, ["rev-parse", `refs/heads/${BRANCH}`])).toBe(stores.jobs.get(ctx.jobId)?.commitSha);
  });

  it("hands back when the agent reports implemented without pushing, and the steward neither commits nor pushes", async () => {
    const brain = agentBrain(implemented, async (workspace) => writeFile(join(workspace, "src/adapter.ts"), "export const adapter = 2;\n"));
    const ctx = claim();

    const outcome = await runImplement(ctx, depsFor(brain));

    expect(outcome).toEqual({ status: "succeeded", warning: "handed back: the agent did not push its change" });
    expect(stores.jobs.get(ctx.jobId)?.implementResult?.handback).toEqual({ label: "readyForHuman", reason: "the agent did not push its change", detail: "uncommitted:\n  src/adapter.ts" });
    expect(await remoteBranches()).toBe("");
  });

  it("hands back with the commits when the agent committed but its push was refused", async () => {
    const brain = agentBrain(implemented, async (workspace, push) => {
      await agentCommit(workspace, "keep the last chunk");
      await push("fix");
    });
    const ctx = claim();

    const outcome = await runImplement(ctx, depsFor(brain));

    expect(outcome).toEqual({ status: "succeeded", warning: "handed back: the agent did not push its change" });
    expect(brain.pushes).toMatchObject([{ ok: false, reason: 'every commit subject must start with "API-1: "; amend or reword these commits' }]);
    expect(stores.jobs.get(ctx.jobId)?.implementResult?.handback?.detail).toMatch(/^commits not pushed:\n {2}[0-9a-f]{7} keep the last chunk$/);
    expect(await remoteBranches()).toBe("");
  });

  it("hands back when the agent left work after its push, never pushing it", async () => {
    const brain = agentBrain(implemented, async (workspace, push) => {
      await agentCommit(workspace, "API-1: Keep the last chunk");
      await push("fix");
      await agentCommit(workspace, "API-1: Test it", "test/adapter.test.ts", "test\n");
      await writeFile(join(workspace, "notes.md"), "draft\n");
    });
    const ctx = claim();

    const outcome = await runImplement(ctx, depsFor(brain));

    expect(outcome).toEqual({ status: "succeeded", warning: "handed back: the agent left unpushed work" });
    const detail = stores.jobs.get(ctx.jobId)?.implementResult?.handback?.detail ?? "";
    expect(detail).toMatch(/^uncommitted:\n {2}notes\.md\ncommits not pushed:\n {2}[0-9a-f]{7} API-1: Test it$/);
    expect(await git(repo.repo, ["log", "--format=%s", `main..refs/heads/${BRANCH}`])).toBe("API-1: Keep the last chunk");
  });

  it("does not count the files the steward copied in as unpushed work", async () => {
    const skillsDir = join(repo.root, "skills");
    await mkdir(join(skillsDir, "verify"), { recursive: true });
    await writeFile(join(skillsDir, "verify/SKILL.md"), "verify\n");
    await writeFile(join(repo.overlayDir, "steward.json"), "{}\n");
    const config = makeConfig();
    const ctx = claim();

    const outcome = await runImplement(ctx, depsFor(agentBrain(implemented), { ...config, workspace: { ...config.workspace, skillsDir } }));

    expect(outcome).toEqual({ status: "succeeded" });
    const sha = stores.jobs.get(ctx.jobId)?.commitSha ?? "";
    expect(await git(repo.repo, ["diff-tree", "--no-commit-id", "--name-only", "-r", sha])).toBe("src/adapter.ts");
  });

  it("marks a push that landed before the tool recorded it, so the job succeeds without pushing again", async () => {
    const brain = agentBrain(implemented);
    const ctx = claim();
    vi.spyOn(stores.jobs, "markPushed").mockImplementationOnce(() => {
      throw new Error("stopped after the push");
    });

    const outcome = await runImplement(ctx, depsFor(brain));

    expect(brain.pushes).toMatchObject([{ ok: false, reason: "push failed" }]);
    expect(outcome).toEqual({ status: "succeeded" });
    const job = stores.jobs.get(ctx.jobId);
    expect(job?.pushedAt).not.toBeNull();
    expect(stores.pushes.forJob(ctx.jobId)).toMatchObject([{ sha: job?.commitSha, pushedAt: expect.any(String) }]);
  });

  it("attaches the screenshots the agent listed and stores what it attached with the result, for the MR summary", async () => {
    const media = [{ path: "after.png", caption: "The adapter's output after the fix" }, { path: "tool.exe", caption: "Not media" }];
    const brain = agentBrain({ ...implemented, media });
    const gitlab = new FakeGitLabMr();
    const deps = { ...depsFor(brain), gitlab };
    const runBrain = async (config: unknown, input: BrainInput): Promise<BrainRun> => {
      await writeFile(join(input.artifactsDir, "after.png"), PNG);
      await writeFile(join(input.artifactsDir, "tool.exe"), "MZ");
      return brain.runBrain(config, input);
    };
    const ctx = claim();

    expect(await runImplement(ctx, { ...deps, runBrain })).toEqual({ status: "succeeded" });

    expect(gitlab.uploads).toEqual([{ project: "acme/repo", filename: "after.png", bytes: PNG.length }]);
    expect(stores.jobs.get(ctx.jobId)?.implementResult?.media).toEqual({
      embeds: [{ caption: "The adapter's output after the fix", markdown: "![after.png](/uploads/1/after.png)" }],
      rejected: [{ name: "tool.exe", reason: "not an image or video (png, jpg, jpeg, gif, webp, mp4, webm)" }],
    });
  });

  it("keeps what a run pod's tools sidecar attached instead of uploading again", async () => {
    const attached = { embeds: [{ caption: "After", markdown: "![a.png](/uploads/9/a.png)" }], rejected: [] };
    const brain = agentBrain({ ...implemented, media: [{ path: "a.png", caption: "After" }] });
    const gitlab = new FakeGitLabMr();
    const pod: RunExecutor = {
      execute: async (spec) => {
        const run = await localExecutor(depsFor(brain)).execute(spec);
        return { ...run, report: { ...run.report, media: attached } };
      },
    };
    const ctx = claim();

    expect(await runImplement(ctx, { ...depsFor(brain), gitlab, executor: pod })).toEqual({ status: "succeeded" });

    expect(gitlab.uploads).toEqual([]);
    expect(stores.jobs.get(ctx.jobId)?.implementResult?.media).toEqual(attached);
  });

  it("runs the local executor's brain on the run's channel: its redacted lines go out, a steer comes in", async () => {
    const brain = agentBrain(implemented);
    const channels = new RunChannels();
    const steered: string[] = [];
    const runBrain: PipelineDeps["runBrain"] = async (config, input, redactor, opts = {}) => {
      opts.onLine?.(redactor.redact('{"type":"assistant","token":"glpat-push-token-value"}'));
      await new Promise<void>((resolve) => {
        opts.control?.({
          steer: (message) => {
            steered.push(message);
            resolve();
          },
          stop: resolve,
        });
      });
      return brain.runBrain(config, input);
    };
    const lines: string[] = [];
    const deps: PipelineDeps = { ...depsFor(brain), runBrain, channels, redactor: new Redactor(["glpat-push-token-value"]) };
    const local = localExecutor(deps);
    const executor: RunExecutor = { execute: (spec, signal) => local.execute(spec, signal, { onLine: (line) => lines.push(line) }) };
    const ctx = claim();

    const running = runImplement(ctx, { ...deps, executor });
    await vi.waitFor(() => expect(channels.active(issue.id)).not.toBeNull());
    expect(channels.steer(channels.active(issue.id) ?? "", "use v2")).toBe(true);

    expect(await running).toEqual({ status: "succeeded" });
    expect(steered).toEqual(["use v2"]);
    expect(lines).toEqual(['{"type":"assistant","token":"***"}']);
    expect(channels.active(issue.id)).toBeNull();
  });

  it("refuses a steer once the local run's brain has ended, while the job still finishes", async () => {
    const channels = new RunChannels();
    const refused: boolean[] = [];
    // The worktree read after the brain is the window: the brain's result is in, the job is not finished.
    const brain = agentBrain(implemented);
    const runBrain: PipelineDeps["runBrain"] = async (config, input) => {
      const run = await brain.runBrain(config, input);
      setImmediate(() => {
        const runId = channels.active(issue.id);
        if (runId !== null) refused.push(channels.steer(runId, "too late"));
      });
      return run;
    };
    const deps: PipelineDeps = { ...depsFor(brain), runBrain, channels };

    expect(await runImplement(claim(), { ...deps, executor: localExecutor(deps) })).toEqual({ status: "succeeded" });
    expect(refused).toEqual([false]);
  });

  it("hands back to needs-info without touching git", async () => {
    const ctx = claim();
    const outcome = await runImplement(ctx, depsFor(agentBrain({ ...implemented, outcome: "needs_info", questions: ["Which stream?"] }, async () => undefined)));

    expect(outcome).toEqual({ status: "succeeded", warning: "handed back: the ticket needs more information" });
    expect(stores.jobs.get(ctx.jobId)?.implementResult?.result?.questions).toEqual(["Which stream?"]);
    expect(await remoteBranches()).toBe("");
  });

  it("hands back to ready-for-human when the agent failed", async () => {
    const ctx = claim();
    await runImplement(ctx, depsFor(agentBrain({ ...implemented, outcome: "failed", failureDetail: "the streaming test keeps failing" }, async () => undefined)));
    expect(recorded(ctx.jobId)).toContain("the streaming test keeps failing");
  });

  it("hands back without running the brain when a branch already carries the ticket", async () => {
    await git(repo.repo, ["branch", "feature/API-1-by-hand"]);
    const brain = agentBrain(implemented);
    const ctx = claim();

    const outcome = await runImplement(ctx, depsFor(brain));

    expect(outcome).toEqual({ status: "succeeded", warning: "handed back: a branch for API-1 already exists" });
    expect(brain.calls).toHaveLength(0);
    expect(recorded(ctx.jobId)).toContain("feature/API-1-by-hand");
  });

  it("finishes a reattached run pod's attempt from its own spec, its push counted as this run's", async () => {
    const ctx = claim();
    // The pod's run, as it went before the steward restarted: the agent pushed, and the pod has not reported yet.
    const executed: RunSpec[] = [];
    const first = agentBrain(implemented, async (workspace, push) => {
      await commitAndPush(workspace, push);
      throw new Error("steward stopped");
    });
    const recording: RunExecutor = {
      execute: async (spec) => {
        executed.push(spec);
        return localExecutor(depsFor(first)).execute(spec);
      },
    };
    expect((await runImplement(ctx, { ...depsFor(first), executor: recording })).status).toBe("failed");
    const [spec] = executed;
    if (spec === undefined) throw new Error("no spec executed");

    const reattached: RunSpec[] = [];
    const pod: RunExecutor = {
      execute: (resumed) => {
        reattached.push(resumed);
        return Promise.resolve({
          report: { runId: resumed.runId, ok: true, error: null, interrupted: false, stopped: false, setupFailed: false, sessionId: "session-1", output: implemented, usage: null },
          work: { runId: resumed.runId, unpushed: "", pushedSha: null },
        });
      },
    };
    const outcome = await runImplement({ ...ctx, resume: spec }, { ...depsFor(agentBrain(implemented)), executor: pod });

    expect(reattached).toEqual([spec]);
    expect(outcome.status).toBe("succeeded");
    expect(outcome).not.toMatchObject({ warning: expect.stringContaining("earlier attempt") });
    expect(stores.jobs.get(ctx.jobId)?.implementResult?.handback).toBeNull();
  });

  it("does not run the brain again when an earlier attempt's agent pushed before the attempt stopped", async () => {
    const ctx = claim();
    const interrupted = agentBrain(implemented, async (workspace, push) => {
      await commitAndPush(workspace, push);
      throw new Error("steward stopped");
    });
    expect((await runImplement(ctx, depsFor(interrupted))).status).toBe("failed");
    const pushed = await git(repo.repo, ["rev-parse", `refs/heads/${BRANCH}`]);

    const again = agentBrain(implemented);
    const outcome = await runImplement({ ...ctx, attempt: 2 }, depsFor(again));

    expect(outcome).toEqual({ status: "succeeded", warning: "handed back: an earlier attempt stopped after the agent pushed" });
    expect(again.calls).toHaveLength(0);
    expect(await git(repo.repo, ["rev-parse", `refs/heads/${BRANCH}`])).toBe(pushed);
    expect(stores.jobs.get(ctx.jobId)?.implementResult?.handback?.detail).toBe(BRANCH);
  });

  it("includes the hand-back detail in a dry run", async () => {
    const ctx = { ...claim(), dryRun: true };
    const outcome = await runImplement(ctx, depsFor(agentBrain({ ...implemented, summary: "" }, async () => undefined)));
    expect(outcome).toEqual({ status: "succeeded", warning: "dry run: would hand back: the agent's result was invalid\nsummary is empty" });
  });

  it("refuses a Done ticket without running the brain", async () => {
    tracker.addIssue({ ...issue, state: { name: "Done", type: "completed" } });
    const brain = agentBrain(implemented);
    const outcome = await runImplement(claim(), depsFor(brain));
    expect(outcome).toEqual({ status: "failed", error: "API-1 is Done; Ticket Steward does not work on Done or Canceled tickets", retryable: false });
    expect(brain.calls).toHaveLength(0);
  });

  it("pushes nothing when the ticket is closed while the agent runs", async () => {
    const brain = agentBrain(implemented, async (workspace, push) => {
      tracker.addIssue({ ...issue, state: { name: "Canceled", type: "canceled" } });
      await commitAndPush(workspace, push);
    });
    const outcome = await runImplement(claim(), depsFor(brain));
    expect(brain.pushes).toMatchObject([{ ok: false, reason: "API-1 is Canceled; Ticket Steward does not work on Done or Canceled tickets" }]);
    expect(outcome).toEqual({ status: "failed", error: "API-1 is Canceled; Ticket Steward does not work on Done or Canceled tickets", retryable: false });
    expect(await remoteBranches()).toBe("");
  });

  it("does not hand back when the ticket is closed while the agent runs", async () => {
    const brain = agentBrain({ ...implemented, outcome: "needs_info", questions: ["Which stream?"] }, async () => {
      tracker.addIssue({ ...issue, state: { name: "Done", type: "completed" } });
    });
    const outcome = await runImplement(claim(), depsFor(brain));
    expect(outcome).toEqual({ status: "failed", error: "API-1 is Done; Ticket Steward does not work on Done or Canceled tickets", retryable: false });
  });

  it("ignores git config planted in the job dir by an earlier attempt", async () => {
    const ctx = claim();
    const jobDir = join(repo.dataDir, "jobs", String(ctx.jobId));
    await git(repo.root, ["init", "--quiet", "--bare", jobDir]);
    await git(jobDir, ["config", `url.${join(repo.root, "nowhere.git")}.insteadOf`, repo.repo]);

    const outcome = await runImplement(ctx, depsFor(agentBrain(implemented)));

    expect(outcome).toEqual({ status: "succeeded" });
    expect(await git(repo.repo, ["rev-parse", "--verify", `refs/heads/${BRANCH}`])).toBe(stores.jobs.get(ctx.jobId)?.commitSha);
  });

  it("runs the brain and the push tool's checks against the slot's app port", async () => {
    const appPortBase = (await freeTcpPort()) - 1;
    const runner = fakeSlotRunner();
    const slots = { count: 1, socket: "/run/steward-slot.sock", appPortBase, upTimeoutSeconds: 180, env: {} };
    const base = makeConfig({ checks: [`test "$STEWARD_PORT" = "${appPortBase + 1}"`] });
    const brain = agentBrain(implemented);
    const ctx = claim();

    const deps = depsFor(brain, { ...base, workspace: { ...base.workspace, port: undefined }, slots });
    const outcome = await runImplement(ctx, brain.bind({ ...deps, slot: { n: 1, client: new SlotClient(slots, runner.run) } }));

    expect(outcome).toEqual({ status: "succeeded" });
    expect(brain.pushes).toMatchObject([{ ok: true }]);
    expect(brain.calls[0]?.env.STEWARD_PORT).toBe(String(appPortBase + 1));
    expect(runner.calls).toEqual([["down", "1"], ["up", "1"], ["ports", "1"], ["down", "1"]]);
  });

  it("fails retryably with the setup tail when workspace setup fails, without running the brain", async () => {
    const brain = agentBrain(implemented);
    const base = makeConfig();
    const ctx = claim();

    const outcome = await runImplement(ctx, depsFor(brain, { ...base, workspace: { ...base.workspace, setup: ["echo installing", "exit 2"] } }));

    expect(outcome).toEqual({ status: "failed", error: "setup failed:\n$ echo installing\ninstalling\n$ exit 2\n[exit 2]\n", retryable: true });
    expect(brain.calls).toHaveLength(0);
    expect(stores.attempts.forJob(ctx.jobId)[0]?.setupTail).toBe("$ echo installing\ninstalling\n$ exit 2\n[exit 2]\n");
  });
});

describe("runImplement through an executor", () => {
  const reportOf = (spec: RunSpec, patch: Partial<RunReport> = {}): RunReport => ({
    runId: spec.runId, ok: true, error: null, interrupted: false, stopped: false, setupFailed: false, sessionId: "session-x", output: implemented, usage: { inputTokens: 1, outputTokens: 1 }, ...patch,
  });

  it("hands the executor a spec that carries no secret, then finishes from its reports", async () => {
    const specs: RunSpec[] = [];
    const executor: RunExecutor = {
      execute: async (spec) => {
        specs.push(spec);
        return { report: reportOf(spec), work: { runId: spec.runId, unpushed: "commits not pushed:\n  a1b2c3d API-1: wip", pushedSha: null } };
      },
    };
    const ctx = claim();

    const outcome = await runImplement(ctx, { ...makeDeps(undefined), executor });

    expect(outcome).toEqual({ status: "succeeded", warning: "handed back: the agent did not push its change" });
    const main = await git(repo.repo, ["rev-parse", "main"]);
    expect(specs).toHaveLength(1);
    expect(RunSpecSchema.parse(JSON.parse(JSON.stringify(specs[0])))).toMatchObject({
      runId: `${ctx.jobId}-1`,
      kind: "implement",
      checkout: { ref: null, sha: main },
      baseSha: main,
      worktreePath: join(repo.dataDir, "work", `${ctx.jobId}-1`),
      push: { jobId: ctx.jobId, mode: "create", branch: null, baseSha: main, loopId: null, worktreePath: join(repo.dataDir, "work", `${ctx.jobId}-1`) },
      resumeSessionId: null,
      interactive: false,
    });
    expect(JSON.stringify(specs[0])).not.toContain("glpat-push-token-value");
    expect(stores.jobs.get(ctx.jobId)).toMatchObject({ sessionId: "session-x", worktreeName: `${ctx.jobId}-1` });
    expect(stores.jobs.get(ctx.jobId)?.implementResult?.handback).toEqual({ label: "readyForHuman", reason: "the agent did not push its change", detail: "commits not pushed:\n  a1b2c3d API-1: wip" });
  });

  it("retries an interrupted run and keeps the tail of a failed setup", async () => {
    const interrupted: RunExecutor = { execute: async (spec) => ({ report: reportOf(spec, { ok: false, error: "interrupted", interrupted: true, sessionId: null }), work: { runId: spec.runId, unpushed: "", pushedSha: null } }) };
    const setup: RunExecutor = {
      execute: async (spec) => ({ report: reportOf(spec, { ok: false, error: "setup failed:\npnpm: not found\n", setupFailed: true, sessionId: null }), work: { runId: spec.runId, unpushed: "", pushedSha: null } }),
    };
    const first = claim();
    expect(await runImplement(first, { ...makeDeps(undefined), executor: interrupted })).toEqual({ status: "failed", error: "interrupted", retryable: true });

    const second = claim({ ...trigger, sessionId: "session-2" });
    expect(await runImplement(second, { ...makeDeps(undefined), executor: setup })).toEqual({ status: "failed", error: "setup failed:\npnpm: not found\n", retryable: true });
    expect(stores.attempts.forJob(second.jobId)[0]?.setupTail).toBe("pnpm: not found\n");
  });

  it("does not retry a run a person stopped, and keeps its session for the next prompt", async () => {
    const stopped: RunExecutor = { execute: async (spec) => ({ report: reportOf(spec, { ok: false, error: "stopped", stopped: true, sessionId: "session-stopped", output: null }), work: { runId: spec.runId, unpushed: "", pushedSha: null } }) };
    const ctx = claim();

    expect(await runImplement(ctx, { ...makeDeps(undefined), executor: stopped })).toEqual({ status: "failed", error: STOPPED_JOB_ERROR, retryable: false });
    expect(stores.jobs.get(ctx.jobId)?.sessionId).toBe("session-stopped");
  });

  it("fails retryably when the executor cannot start the run", async () => {
    const executor: RunExecutor = { execute: () => Promise.reject(new Error("cannot create the run's Job")) };
    const ctx = claim();

    expect(await runImplement(ctx, { ...makeDeps(undefined), executor })).toEqual({ status: "failed", error: "cannot create the run's Job", retryable: true });
  });
});

describe("runImplement in the ticket's agent session", () => {
  const thoughtLine = (text: string): string => JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text }] } });
  const reportOf = (spec: RunSpec, patch: Partial<RunReport> = {}): RunReport => ({
    runId: spec.runId, ok: true, error: null, interrupted: false, stopped: false, setupFailed: false, sessionId: "session-x", output: implemented, usage: { inputTokens: 1, outputTokens: 1 }, ...patch,
  });
  /** An executor whose brain says `thought`, then reports `patch`; the specs it was given are kept. */
  const thinking = (thought: string, patch: Partial<RunReport>, specs: RunSpec[] = []): RunExecutor => ({
    execute: async (spec, _signal, hooks) => {
      specs.push(spec);
      hooks?.onLine?.(thoughtLine(thought));
      return { report: reportOf(spec, patch), work: { runId: spec.runId, unpushed: "", pushedSha: null } };
    },
  });
  const questions = { ...implemented, outcome: "needs_info" as const, questions: ["Which adapter, S3 or GCS?"] };
  let linear: RecordingLinear;

  beforeEach(() => {
    linear = new RecordingLinear();
    stores.agentSessions.record("session-1", "issue-1", "API-1");
  });

  it("shows the brain's lines in the panel, then asks its questions as an elicitation", async () => {
    const ctx = claim();
    const outcome = await runImplement(ctx, { ...makeDeps(undefined), linear, executor: thinking("Reading the adapter.", { output: questions, sessionId: "session-q" }) });

    expect(outcome).toEqual({ status: "succeeded", warning: "handed back: the ticket needs more information" });
    expect(linear.activities().map((call) => [call.sessionId, call.content.type])).toEqual([["session-1", "thought"], ["session-1", "elicitation"]]);
    expect(linear.activities()[1]?.content).toMatchObject({ body: expect.stringContaining("- Which adapter, S3 or GCS?") });
  });

  it("continues the implement that asked, in its session and worktree, with the person's reply in the prompt", async () => {
    const asked = claim();
    await runImplement(asked, { ...makeDeps(undefined), linear, executor: thinking("Reading.", { output: questions, sessionId: "session-q" }) });
    stores.jobs.finish(asked.jobId, { status: "succeeded" });

    const specs: RunSpec[] = [];
    const answered = claim({ ...trigger, message: "The S3 adapter.", author: "Ada" });
    await runImplement(answered, { ...makeDeps(undefined), linear, executor: thinking("Implementing.", { sessionId: "session-q" }, specs) });

    expect(specs[0]).toMatchObject({ resumeSessionId: "session-q", worktreePath: join(repo.dataDir, "work", `${asked.jobId}-1`) });
    expect(specs[0]?.prompt).toContain("The S3 adapter.");
    expect(stores.jobs.get(answered.jobId)?.worktreeName).toBe(`${asked.jobId}-1`);
  });

  it("says where a stopped run got to, once, as a response", async () => {
    const ctx = claim();
    const outcome = await runImplement(ctx, { ...makeDeps(undefined), linear, executor: thinking("Halfway through the adapter.", { ok: false, error: "stopped", stopped: true, output: null }) });

    expect(outcome).toEqual({ status: "failed", error: STOPPED_JOB_ERROR, retryable: false });
    const finals = linear.activities().filter((call) => call.content.type !== "thought");
    expect(finals.map((call) => call.content)).toEqual([{ type: "response", body: "Stopped. Where I got to: Halfway through the adapter." }]);
  });

  it("answers a pushed change with its summary", async () => {
    const brain = agentBrain(implemented);
    const ctx = claim();
    expect(await runImplement(ctx, { ...depsFor(brain), linear })).toEqual({ status: "succeeded" });
    expect(linear.activities().at(-1)?.content).toEqual({ type: "response", body: "Flush the buffer before closing the stream.\n\n**Checks I ran**\n- tsc: ok" });
  });

  it("makes no Linear call for a ticket with no agent session", async () => {
    const ctx = claim({ ...trigger, issueId: "issue-2", identifier: "API-2" });
    tracker.addIssue({ ...issue, id: "issue-2", identifier: "API-2" });
    await runImplement(ctx, { ...makeDeps(undefined), linear, executor: thinking("Reading.", { output: questions }) });
    expect(linear.calls).toEqual([]);
  });
});

describe("the fix loop start", () => {
  const GREPTILE = {
    botUsername: "greptile-bot", maxRounds: 5, prompt: "/dev/null", pollSeconds: 60, mrTimeoutMinutes: 60,
    reviewTimeoutMinutes: 30, pipelineTimeoutMinutes: 60, ciLogLines: 200,
  };
  const withGreptile = (): StewardConfig => ({ ...makeConfig(), greptile: GREPTILE });

  /** An agent that commits, pushes and leaves session `session-impl`. */
  const sessionBrain = (): AgentBrain => {
    const brain = agentBrain(implemented);
    return { ...brain, runBrain: async (config: unknown, input: BrainInput) => ({ ...(await brain.runBrain(config, input)), sessionId: "session-impl" }) };
  };

  const awaitJobs = () => stores.jobs.list({ limit: 50 }).filter((job) => job.kind === "await_review");

  it("starts a loop on a stable worktree after a label-triggered push", async () => {
    const brain = sessionBrain();
    const ctx = claim();

    const outcome = await runImplement(ctx, depsFor(brain, withGreptile()));

    expect(outcome).toEqual({ status: "succeeded" });
    expect(brain.calls[0]?.workspacePath).toBe(join(repo.dataDir, "work", "ticket-API-1"));
    const job = stores.jobs.get(ctx.jobId);
    expect(job?.sessionId).toBe("session-impl");
    expect(job).toMatchObject({ worktreeName: "ticket-API-1", baseSha: await git(repo.repo, ["rev-parse", "main"]) });
    const loop = stores.loops.forImplementJob(ctx.jobId);
    expect(loop).toMatchObject({ headSha: job?.commitSha, sessionId: "session-impl", worktreeName: "ticket-API-1", branch: BRANCH, labelDriven: true, round: 0 });
    expect(loop?.baseSha).toBe(await git(repo.repo, ["rev-parse", "main"]));
    expect(awaitJobs().map((row) => row.trigger)).toEqual([{ kind: "loop", issueId: "issue-1", identifier: "API-1", teamKey: "API", loopId: loop?.id, step: "await" }]);
  });

  it("parks a handed-back loop, with nothing queued, when the agent pushed and left unpushed work", async () => {
    const brain = agentBrain(implemented, async (workspace, push) => {
      await commitAndPush(workspace, push);
      await writeFile(join(workspace, "notes.md"), "draft\n");
    });
    const ctx = claim();

    expect(await runImplement(ctx, depsFor(brain, withGreptile()))).toEqual({ status: "succeeded", warning: "handed back: the agent left unpushed work" });
    expect(stores.loops.forImplementJob(ctx.jobId)).toMatchObject({ state: "handed_back", headSha: stores.jobs.get(ctx.jobId)?.commitSha });
    expect(awaitJobs()).toEqual([]);
  });

  /** An agent that pushes, then is stopped by a person (or the steward's removal) before it reports. */
  const stoppedAfterPush = (): AgentBrain => {
    const brain = agentBrain(implemented);
    return { ...brain, runBrain: async (config: unknown, input: BrainInput) => ({ ...(await brain.runBrain(config, input)), ok: false, error: "stopped", output: undefined }) };
  };

  it("parks a handed-back loop for an implement stopped after it pushed, so being delegated again resumes it", async () => {
    const ctx = claim();

    expect(await runImplement(ctx, depsFor(stoppedAfterPush(), withGreptile()))).toEqual({ status: "failed", error: STOPPED_JOB_ERROR, retryable: false });

    expect(stores.loops.forImplementJob(ctx.jobId)).toMatchObject({ state: "handed_back", branch: BRANCH, headSha: stores.jobs.get(ctx.jobId)?.commitSha });
    expect(awaitJobs()).toEqual([]);
  });

  it("parks the loop unassigned when the steward was removed while the implement ran", async () => {
    const ctx = claim();
    stores.agentSessions.markUnassigned("issue-1");

    expect((await runImplement(ctx, depsFor(stoppedAfterPush(), withGreptile()))).status).toBe("failed");

    expect(stores.loops.forImplementJob(ctx.jobId)?.state).toBe("unassigned");
    expect(awaitJobs()).toEqual([]);
  });

  it("starts no loop for a cli trigger, which keeps the per-attempt worktree", async () => {
    const brain = sessionBrain();
    const ctx = claim({ kind: "cli", issueId: "issue-1", identifier: "API-1", teamKey: "API", action: "implement" });

    expect(await runImplement(ctx, depsFor(brain, withGreptile()))).toEqual({ status: "succeeded" });

    expect(brain.calls[0]?.workspacePath).toBe(join(repo.dataDir, "work", `${ctx.jobId}-1`));
    expect(stores.loops.forImplementJob(ctx.jobId)).toBeNull();
    expect(awaitJobs()).toEqual([]);
  });

  it("starts no loop without greptile configured", async () => {
    const brain = sessionBrain();
    const ctx = claim();

    expect(await runImplement(ctx, depsFor(brain))).toEqual({ status: "succeeded" });

    expect(brain.calls[0]?.workspacePath).toBe(join(repo.dataDir, "work", `${ctx.jobId}-1`));
    expect(stores.loops.forImplementJob(ctx.jobId)).toBeNull();
  });

  it("starts the loop exactly once, on the stored base, when publishImplementOnly retries after a crash", async () => {
    const brain = sessionBrain();
    const ctx = claim();
    vi.spyOn(stores.loops, "create").mockImplementationOnce(() => {
      throw new Error("crashed before the loop");
    });
    expect((await runImplement(ctx, depsFor(brain, withGreptile()))).status).toBe("failed");
    expect(stores.loops.forImplementJob(ctx.jobId)).toBeNull();

    tracker.failNextRead();
    expect((await publishImplementOnly({ ...ctx, attempt: 2 }, makeDeps(undefined, withGreptile()))).status).toBe("publish_failed");
    const retry = await publishImplementOnly({ ...ctx, attempt: 3 }, makeDeps(undefined, withGreptile()));

    expect(retry).toEqual({ status: "succeeded" });
    const job = stores.jobs.get(ctx.jobId);
    expect(stores.loops.forImplementJob(ctx.jobId)).toMatchObject({ headSha: job?.commitSha, sessionId: "session-impl", worktreeName: "ticket-API-1", baseSha: await git(repo.repo, ["rev-parse", "main"]) });
    expect(awaitJobs()).toHaveLength(1);
    expect(brain.calls).toHaveLength(1);
  });
});

describe("publishImplementOnly", () => {
  it("re-publishes after a failed ticket read without pushing again", async () => {
    const ctx = claim();
    const first = await runImplement(ctx, depsFor(agentBrain(implemented, pushThenLinearDown)));
    expect(first.status).toBe("publish_failed");
    const pushed = await git(repo.repo, ["rev-parse", `refs/heads/${BRANCH}`]);

    const retry = await publishImplementOnly({ ...ctx, attempt: 2 }, makeDeps(undefined));

    expect(retry).toEqual({ status: "succeeded" });
    expect(await git(repo.repo, ["rev-parse", `refs/heads/${BRANCH}`])).toBe(pushed);
  });

  it("treats its own already-landed push as pushed when the record was lost", async () => {
    const ctx = claim();
    await runImplement(ctx, depsFor(agentBrain(implemented, pushThenLinearDown)));
    stores.db.prepare("UPDATE jobs SET pushed_at = NULL WHERE id = ?").run(ctx.jobId);

    const retry = await publishImplementOnly({ ...ctx, attempt: 2 }, makeDeps(undefined));

    expect(retry).toEqual({ status: "succeeded" });
    expect(stores.jobs.get(ctx.jobId)?.pushedAt).not.toBeNull();
  });

  it("hands back without pushing when the recorded push never landed", async () => {
    const ctx = claim();
    const sha = await git(repo.repo, ["rev-parse", "main"]);
    stores.jobs.recordCommit(ctx.jobId, BRANCH, sha);
    stores.jobs.saveImplementResult(ctx.jobId, { result: implemented, handback: null, baseSha: sha });

    const retry = await publishImplementOnly({ ...ctx, attempt: 2 }, makeDeps(undefined));

    expect(retry).toEqual({ status: "succeeded", warning: "handed back: the push did not complete" });
    expect(await remoteBranches()).toBe("");
    expect(stores.jobs.get(ctx.jobId)?.implementResult?.handback).toEqual({ label: "readyForHuman", reason: "the push did not complete", detail: BRANCH });
  });

  it("does not record a push when the remote is unreachable", async () => {
    const ctx = claim();
    const deps = depsFor(agentBrain(implemented));
    const unreachable = { ...deps, config: { ...deps.config, workspace: { ...deps.config.workspace, fetchUrl: join(repo.root, "missing.git") } } };

    const outcome = await runImplement(ctx, unreachable);

    expect(outcome).toMatchObject({ status: "failed", retryable: true });
    expect(stores.jobs.get(ctx.jobId)?.pushedAt ?? null).toBeNull();
  });
});
