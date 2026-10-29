import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { StewardConfig } from "../../src/config/schema.js";
import { Redactor } from "../../src/core/redact.js";
import { storeLedger } from "../../src/push/ledger.js";
import { pushFromWorktree, type PushDeps } from "../../src/push/service.js";
import type { PushTarget } from "../../src/push/target.js";
import { openStores, type Stores } from "../../src/store/index.js";
import { toolsGuard } from "../../src/tools/guard.js";
import type { TicketBundle, TriggerEvent } from "../../src/tracker/types.js";
import { createWorktree, type Worktree } from "../../src/workspace/worktree.js";
import { FakeTracker } from "../fakes/fakeTracker.js";
import { freeTcpPort, tmpRepo, type TmpRepo } from "../fakes/tmpRepo.js";
import { commitFile, git } from "../workspace/helpers.js";

const LABELS = { implement: "ready-for-agent", needsInfo: "needs-info", readyForHuman: "ready-for-human", implemented: "agent-implemented", approved: "agent-approved" };
const BRANCH = "fix/API-1-adapter-drops-the-last-chunk";
const PUSH_TOKEN = "glpat-push-token-value";

const issue: TicketBundle = {
  id: "issue-1",
  identifier: "API-1",
  url: "https://linear.app/acme/issue/API-1",
  title: "Adapter drops the last chunk",
  description: "The adapter loses the final chunk.",
  team: { id: "team-1", key: "API", name: "API" },
  state: { name: "In Progress", type: "started" },
  labels: ["ready-for-agent"],
  priority: 2,
  creator: { name: "Ada", isBot: false },
  createdAt: "2026-10-27T00:00:00.000Z",
  comments: [],
  attachments: [],
  appliedTemplate: null,
  templates: [],
};

const trigger: TriggerEvent = { kind: "issue.labeled", issueId: "issue-1", identifier: "API-1", teamKey: "API", deliveryId: "d-1", description: issue.description, stateType: "started", action: "implement" };

let repo: TmpRepo;
let stores: Stores;
let tracker: FakeTracker;
let worktree: Worktree;
let jobId: number;
let port: number;

const makeConfig = (checks: string[] = []): StewardConfig => ({
  dataDir: repo.dataDir,
  brain: { kind: "claude-code", model: "claude-test", maxTurns: 5, timeoutMinutes: 1 },
  tracker: { kind: "linear", teams: ["API"], labels: LABELS },
  codehost: { kind: "gitlab", baseUrl: "https://gitlab.example", project: "acme/repo" },
  workspace: { fetchUrl: repo.repo, baseBranch: "main", overlayDir: repo.overlayDir, setup: [], setupTimeoutMinutes: 1, port, keepOnFailure: false },
  retention: { keptWorktrees: 3, days: 30 },
  server: { port: 3020, publicUrl: "https://steward.example" },
  implement: {
    prompt: "unused",
    branchTypes: ["feature", "fix", "chore", "refactor"],
    checks,
    checksTimeoutMinutes: 1,
    commitAuthor: { name: "Ticket Steward", email: "steward@example.com" },
    timeoutMinutes: 1,
    maxTurns: 5,
    protectedBranches: ["main"],
  },
});

const makeDeps = (config: StewardConfig = makeConfig()): PushDeps => ({
  config,
  secrets: { GITLAB_PUSH_TOKEN: PUSH_TOKEN },
  mirror: repo.mirror,
  ledger: storeLedger({ stores, tracker }),
  redactor: new Redactor([PUSH_TOKEN]),
});

const createTarget = (over: Partial<PushTarget> = {}): PushTarget => ({
  jobId,
  worktreePath: worktree.path,
  identifier: "API-1",
  issueId: "issue-1",
  mode: "create",
  branch: null,
  baseSha: repo.sha,
  loopId: null,
  port,
  ...over,
});

/** The agent's own commit in the worktree. */
const agentCommit = async (subject: string, content = "export const adapter = 2;\n", file = "src/adapter.ts"): Promise<string> => {
  await mkdir(join(worktree.path, file, ".."), { recursive: true });
  await writeFile(join(worktree.path, file), content);
  await git(worktree.path, ["add", "--", file]);
  await git(worktree.path, ["commit", "-q", "-m", subject]);
  return git(worktree.path, ["rev-parse", "HEAD"]);
};

const remoteHead = (branch: string): Promise<string> => git(repo.repo, ["rev-parse", `refs/heads/${branch}`]);

const push = (target: PushTarget = createTarget(), branchType: string | null = "fix", deps: PushDeps = makeDeps()) => pushFromWorktree({ deps, target, branchType });

/** A loop whose branch is on the remote at a first steward commit, as after implement pushed it. */
const pushedLoop = async (): Promise<{ loopId: number; head: string }> => {
  const head = await agentCommit("API-1: first");
  await git(worktree.path, ["push", "-q", repo.repo, `${head}:refs/heads/${BRANCH}`]);
  const loopId = stores.loops.create({
    issueId: "issue-1", identifier: "API-1", teamKey: "API", implementJobId: jobId, branch: BRANCH, baseSha: repo.sha, headSha: head,
    worktreeName: "ticket-API-1", labelDriven: true, sessionId: "session-1",
  });
  return { loopId, head };
};

beforeEach(async () => {
  repo = await tmpRepo("unused");
  await commitFile(repo.repo, ".gitignore", ".env\n");
  repo.sha = await git(repo.repo, ["rev-parse", "HEAD"]);
  await repo.mirror.fetch();
  stores = openStores(repo.dataDir);
  tracker = new FakeTracker([issue]);
  port = await freeTcpPort();
  worktree = await createWorktree(repo.mirror, join(repo.dataDir, "work"), "ticket-API-1", repo.sha);
  jobId = stores.jobs.enqueue(trigger);
});

afterEach(async () => {
  stores.db.close();
  await repo.cleanup();
});

describe("pushFromWorktree refusals", () => {
  it("refuses uncommitted changes, naming them, but ignores files the steward copied in", async () => {
    await agentCommit("API-1: keep the last chunk");
    await writeFile(join(repo.overlayDir, "steward.json"), "{}\n");
    await writeFile(join(worktree.path, "steward.json"), "{}\n");
    await writeFile(join(worktree.path, "notes.md"), "draft\n");

    expect(await push()).toEqual({ ok: false, reason: "commit or discard your changes first", detail: "notes.md" });
  });

  it("refuses when the mirror carries a grafts file that could hide commits from the guard", async () => {
    await agentCommit("API-1: first");
    await mkdir(join(repo.mirror.path, "info"), { recursive: true });
    await writeFile(join(repo.mirror.path, "info", "grafts"), "");

    expect(await push()).toMatchObject({ ok: false, reason: "the worktree's git directory was changed; restore it before pushing", detail: expect.stringContaining("grafts is present") });
  });

  it("refuses when the worktree's .git points at another repository", async () => {
    await agentCommit("API-1: first");
    const other = join(repo.dataDir, "other");
    await git(repo.dataDir, ["clone", "-q", repo.repo, other]);
    await writeFile(join(worktree.path, ".git"), `gitdir: ${join(other, ".git")}\n`);

    expect(await push()).toMatchObject({ ok: false, detail: expect.stringContaining("not the steward's mirror") });
  });

  it.each([
    ["core.worktree", ["config", "--worktree", "core.worktree", "/"]],
    ["core.bare", ["config", "--worktree", "core.bare", "true"]],
  ])("refuses when the worktree's config sets %s, without showing what it names", async (_key, args) => {
    await agentCommit("API-1: first");
    await git(worktree.path, ["config", "extensions.worktreeConfig", "true"]);
    await git(worktree.path, args);

    expect(await push()).toEqual({
      ok: false,
      reason: "the worktree's git directory was changed; restore it before pushing",
      detail: "the git directory's config sets core.worktree or core.bare",
    });
  });

  it("refuses when there is nothing new on the base", async () => {
    expect(await push()).toEqual({ ok: false, reason: `nothing to push: HEAD is already at ${repo.sha.slice(0, 7)}`, detail: "" });
  });

  it("refuses a merge commit in the series", async () => {
    const one = await agentCommit("API-1: one");
    await git(worktree.path, ["checkout", "-q", "-b", "side", repo.sha]);
    await agentCommit("API-1: two", "x\n", "src/other.ts");
    await git(worktree.path, ["checkout", "-q", "--detach", one]);
    await git(worktree.path, ["merge", "-q", "--no-ff", "--no-edit", "-m", "API-1: merge", "side"]);

    expect(await push()).toMatchObject({ ok: false, reason: `HEAD must be new commits on top of ${repo.sha.slice(0, 7)}`, detail: expect.stringContaining("is a merge commit") });
  });

  it("refuses a commit whose subject does not start with the identifier, naming it", async () => {
    await agentCommit("API-1: first");
    const bad = await agentCommit("fix the adapter", "export const adapter = 3;\n");

    expect(await push()).toEqual({ ok: false, reason: 'every commit subject must start with "API-1: "; amend or reword these commits', detail: `${bad.slice(0, 7)} fix the adapter` });
  });

  it("refuses a change that carries a secret value without naming the value", async () => {
    await agentCommit("API-1: config", `export const token = "${PUSH_TOKEN}";\n`);

    const result = await push();

    expect(result).toEqual({ ok: false, reason: "the change contains a secret value", detail: "src/adapter.ts" });
    expect(JSON.stringify(result)).not.toContain(PUSH_TOKEN);
  });

  it("refuses a commit message that carries a secret value", async () => {
    await agentCommit(`API-1: x\n\ntoken ${PUSH_TOKEN}`);

    expect(await push()).toMatchObject({ ok: false, reason: "the commit message contains a secret value" });
  });

  it("refuses when the steward's checks fail, with the redacted tail", async () => {
    await agentCommit("API-1: keep the last chunk");

    const result = await push(createTarget(), "fix", makeDeps(makeConfig([`echo ${PUSH_TOKEN} {{baseSha}}; exit 3`])));

    expect(result).toMatchObject({ ok: false, reason: "the steward's checks failed" });
    expect(result.ok ? "" : result.detail).toContain(`*** ${repo.sha}`);
  });

  it("takes the checks' result from its check runner", async () => {
    await agentCommit("API-1: keep the last chunk");
    const ran: string[][] = [];
    const checks = { run: (commands: string[]) => (ran.push(commands), Promise.resolve({ ok: false, tail: "lint failed" })) };

    const result = await push(createTarget(), "fix", { ...makeDeps(makeConfig(["pnpm lint {{baseSha}}"])), checks });

    expect(result).toEqual({ ok: false, reason: "the steward's checks failed", detail: "lint failed" });
    expect(ran).toEqual([[`pnpm lint ${repo.sha}`]]);
  });

  it("refuses a commit carrying a placeholder from the guard file", async () => {
    const placeholder = "STEWARD_PH_STRIPE_SECRET_KEY_0123456789abcdef";
    const guardFile = join(repo.root, "guard.json");
    await writeFile(guardFile, JSON.stringify(["sk_test_real_value", placeholder]));
    await agentCommit("API-1: config", `export const key = "${placeholder}";\n`);
    const deps = makeDeps();

    const result = await push(createTarget(), "fix", { ...deps, guard: toolsGuard({ guardFile, overlayDir: repo.overlayDir, skillsDir: undefined, secrets: deps.secrets }) });

    expect(result).toEqual({ ok: false, reason: "the change contains a secret value", detail: "src/adapter.ts" });
  });

  it("refuses when the ticket was closed during the run, and pushes nothing", async () => {
    await agentCommit("API-1: keep the last chunk");
    tracker.addIssue({ ...issue, state: { name: "Done", type: "completed" } });

    expect(await push()).toMatchObject({ ok: false, reason: "API-1 is Done; Ticket Steward does not work on Done or Canceled tickets" });
    expect(await git(repo.repo, ["branch", "--list", "*API-1*"])).toBe("");
    expect(stores.jobs.get(jobId)?.branch).toBeNull();
  });

  it("refuses a first push without a configured branch type", async () => {
    await agentCommit("API-1: keep the last chunk");

    expect(await push(createTarget(), null)).toEqual({ ok: false, reason: "the first push needs a branchType, one of: feature, fix, chore, refactor", detail: "" });
    expect(await push(createTarget(), "hotfix")).toMatchObject({ ok: false, reason: "the first push needs a branchType, one of: feature, fix, chore, refactor" });
  });

  it("refuses to create a branch when one already carries the ticket, naming it", async () => {
    await git(repo.repo, ["branch", "feature/API-1-by-hand", repo.sha]);
    await agentCommit("API-1: keep the last chunk");

    expect(await push()).toEqual({ ok: false, reason: "a branch for API-1 already exists", detail: "feature/API-1-by-hand" });
  });
});

describe("pushFromWorktree pushes", () => {
  it("creates the ticket branch at HEAD and records the job as pushed", async () => {
    await agentCommit("API-1: keep the last chunk");
    const sha = await agentCommit("API-1: test it", "test\n", "test/adapter.test.ts");

    expect(await push()).toEqual({ ok: true, branch: BRANCH, sha, commits: 2 });
    expect(await remoteHead(BRANCH)).toBe(sha);
    const job = stores.jobs.get(jobId);
    expect(job).toMatchObject({ branch: BRANCH, commitSha: sha });
    expect(job?.pushedAt).not.toBeNull();
    expect(stores.pushes.forJob(jobId)).toMatchObject([{ branch: BRANCH, sha, previousSha: null }]);
  });

  it("fast-forwards the branch on a second push in the same run", async () => {
    const first = await agentCommit("API-1: keep the last chunk");
    await push();
    const second = await agentCommit("API-1: and test it", "test\n", "test/adapter.test.ts");

    expect(await push(createTarget(), null)).toEqual({ ok: true, branch: BRANCH, sha: second, commits: 1 });
    expect(await remoteHead(BRANCH)).toBe(second);
    expect(stores.jobs.get(jobId)).toMatchObject({ commitSha: second });
    expect(stores.pushes.forJob(jobId).map((row) => row.previousSha)).toEqual([null, first]);
  });

  it("fast-forwards a loop's branch and moves the loop's head with it", async () => {
    const { loopId, head } = await pushedLoop();
    const sha = await agentCommit("API-1: address review", "export const adapter = 9;\n");

    const result = await push(createTarget({ mode: "fastForward", branch: BRANCH, loopId }), null);

    expect(result).toEqual({ ok: true, branch: BRANCH, sha, commits: 1 });
    expect(await remoteHead(BRANCH)).toBe(sha);
    expect(stores.loops.get(loopId)).toMatchObject({ headSha: sha, pendingPush: { sha, pushed: true } });
    expect(stores.pushes.forJob(jobId)).toMatchObject([{ loopId, previousSha: head }]);
  });

  it("refuses a loop push when the branch moved, and leaves the loop as it was", async () => {
    const { loopId, head } = await pushedLoop();
    await git(repo.repo, ["branch", "-f", BRANCH, repo.sha]);
    await agentCommit("API-1: address review", "export const adapter = 9;\n");

    const result = await push(createTarget({ mode: "fastForward", branch: BRANCH, loopId }), null);

    expect(result).toMatchObject({ ok: false, reason: "the push was rejected" });
    expect(JSON.stringify(result)).not.toContain(PUSH_TOKEN);
    expect(await remoteHead(BRANCH)).toBe(repo.sha);
    expect(stores.loops.get(loopId)).toMatchObject({ headSha: head, pendingPush: null });
  });

  it("fast-forwards from a job the old steward-side code pushed, which has no push rows", async () => {
    const first = await agentCommit("API-1: keep the last chunk");
    await git(worktree.path, ["push", "-q", repo.repo, `${first}:refs/heads/${BRANCH}`]);
    stores.jobs.recordCommit(jobId, BRANCH, first);
    stores.jobs.markPushed(jobId);
    const second = await agentCommit("API-1: and test it", "test\n", "test/adapter.test.ts");

    const result = await push(createTarget({ mode: "fastForward", branch: BRANCH }), null);

    expect(result).toEqual({ ok: true, branch: BRANCH, sha: second, commits: 1 });
    expect(await remoteHead(BRANCH)).toBe(second);
    expect(stores.pushes.forJob(jobId)).toMatchObject([{ branch: BRANCH, sha: second, previousSha: first }]);
  });

  it("settles a push that landed before it was recorded and fast-forwards from it", async () => {
    const first = await agentCommit("API-1: keep the last chunk");
    // A push that landed, then the steward stopped before marking it.
    stores.pushes.record({ jobId, loopId: null, branch: BRANCH, sha: first, previousSha: null, note: null });
    stores.jobs.recordCommit(jobId, BRANCH, first);
    await git(worktree.path, ["push", "-q", repo.repo, `${first}:refs/heads/${BRANCH}`]);
    const second = await agentCommit("API-1: and test it", "test\n", "test/adapter.test.ts");

    expect(await push()).toEqual({ ok: true, branch: BRANCH, sha: second, commits: 1 });
    expect(await remoteHead(BRANCH)).toBe(second);
  });
});
