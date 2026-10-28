import { existsSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { StewardConfig } from "../../src/config/schema.js";
import { Redactor } from "../../src/core/redact.js";
import { guardRange, unpushedWork } from "../../src/implement/git.js";
import { storeLedger } from "../../src/push/ledger.js";
import { pushFromWorktree } from "../../src/push/service.js";
import { openStores, type Stores } from "../../src/store/index.js";
import { safeGitArgs, safeGitEnv } from "../../src/tools/gitSafe.js";
import type { TicketBundle } from "../../src/tracker/types.js";
import { createWorktree, type Worktree } from "../../src/workspace/worktree.js";
import { FakeTracker } from "../fakes/fakeTracker.js";
import { tmpRepo, type TmpRepo } from "../fakes/tmpRepo.js";
import { git } from "../workspace/helpers.js";

const LABELS = { implement: "ready-for-agent", needsInfo: "needs-info", readyForHuman: "ready-for-human", implemented: "agent-implemented", approved: "agent-approved" };
const BRANCH = "fix/API-1-adapter-drops-the-last-chunk";

const issue: TicketBundle = {
  id: "issue-1",
  identifier: "API-1",
  url: "https://linear.app/acme/issue/API-1",
  title: "Adapter drops the last chunk",
  description: "",
  team: { id: "team-1", key: "API", name: "API" },
  state: { name: "In Progress", type: "started" },
  labels: [],
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
let worktree: Worktree;
let marker: string;
let evil: string;

const config = (): StewardConfig => ({
  dataDir: repo.dataDir,
  brain: { kind: "claude-code", model: "claude-test", maxTurns: 5, timeoutMinutes: 1 },
  tracker: { kind: "linear", teams: ["API"], labels: LABELS },
  codehost: { kind: "gitlab", baseUrl: "https://gitlab.example", project: "acme/repo" },
  workspace: { fetchUrl: repo.repo, baseBranch: "main", overlayDir: repo.overlayDir, setup: [], setupTimeoutMinutes: 1, port: 4100, keepOnFailure: false },
  retention: { keptWorktrees: 3, days: 30 },
  server: { port: 3020, publicUrl: "https://steward.example" },
  implement: {
    prompt: "unused",
    branchTypes: ["fix"],
    checks: [],
    checksTimeoutMinutes: 1,
    commitAuthor: { name: "Ticket Steward", email: "steward@example.com" },
    timeoutMinutes: 1,
    maxTurns: 5,
    protectedBranches: ["main"],
  },
});

/** The agent's hostile config: a program on every index refresh, a clean filter on every file, and the remote redirected. */
const poison = async (): Promise<void> => {
  await git(worktree.path, ["config", "core.fsmonitor", `touch ${marker}-fsmonitor; true`]);
  await git(worktree.path, ["config", "filter.x.clean", `touch ${marker}-clean; cat`]);
  await git(worktree.path, ["config", "filter.x.process", `touch ${marker}-process; true`]);
  await git(worktree.path, ["config", "filter.x.required", "true"]);
  await git(worktree.path, ["config", "diff.x.textconv", `touch ${marker}-textconv; cat`]);
  await git(worktree.path, ["config", "log.showSignature", "true"]);
  await git(worktree.path, ["config", `url.${evil}.insteadOf`, repo.repo]);
  const common = await git(worktree.path, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
  await mkdir(join(common, "info"), { recursive: true });
  await writeFile(join(common, "info", "attributes"), "* filter=x diff=x\n");
};

const markers = (): string[] => ["fsmonitor", "clean", "process", "textconv"].filter((name) => existsSync(`${marker}-${name}`));

beforeEach(async () => {
  repo = await tmpRepo("unused");
  stores = openStores(repo.dataDir);
  worktree = await createWorktree(repo.mirror, join(repo.dataDir, "work"), "ticket-API-1", repo.sha);
  marker = join(repo.root, "pwned");
  evil = join(repo.root, "evil.git");
  await git(repo.root, ["init", "-q", "--bare", evil]);
});

afterEach(async () => {
  stores.db.close();
  await repo.cleanup();
});

describe("safeGitArgs", () => {
  it("overrides config that runs programs or reaches remotes", () => {
    expect(safeGitArgs()).toEqual(expect.arrayContaining(["-c", "core.fsmonitor=false", "-c", "core.hooksPath=/dev/null", "-c", "core.sshCommand=", "-c", "diff.external=", "-c", "protocol.allow=never"]));
    expect(safeGitEnv()).toEqual({ GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_NO_REPLACE_OBJECTS: "1", GIT_ATTR_NOSYSTEM: "1" });
  });
});

describe("git on an agent's worktree", () => {
  it("runs nothing the worktree's config names, and the push lands on the configured remote", async () => {
    await mkdir(join(worktree.path, "src"), { recursive: true });
    await writeFile(join(worktree.path, "src", "adapter.ts"), "export const adapter = 2;\n");
    await git(worktree.path, ["add", "--", "src/adapter.ts"]);
    await git(worktree.path, ["commit", "-q", "-m", "API-1: keep the last chunk"]);
    const sha = await git(worktree.path, ["rev-parse", "HEAD"]);
    await poison();
    // A stale stat makes git re-read the file through the filter.
    await writeFile(join(worktree.path, "src", "adapter.ts"), "export const adapter = 3;\n");
    // The attack is real: plain git runs the agent's programs.
    await git(worktree.path, ["diff", "--name-only", "HEAD"]).catch(() => "");
    expect(markers().length).toBeGreaterThan(0);
    for (const name of ["fsmonitor", "clean", "process", "textconv"]) await rm(`${marker}-${name}`, { force: true });

    const work = await unpushedWork({ worktreePath: worktree.path, pushedSha: repo.sha, stewardFiles: [] });
    expect(work.uncommitted).toEqual(["src/adapter.ts"]);
    expect(await guardRange({ worktreePath: worktree.path, baseSha: repo.sha, headSha: sha, stewardFiles: [], secretValues: ["export const adapter"] })).toMatchObject({ ok: false });
    expect(markers()).toEqual([]);

    await writeFile(join(worktree.path, "src", "adapter.ts"), "export const adapter = 2;\n");
    const result = await pushFromWorktree({
      deps: {
        config: config(),
        secrets: { GITLAB_PUSH_TOKEN: "glpat-push-token-value" },
        mirror: repo.mirror,
        ledger: storeLedger({ stores, tracker: new FakeTracker([issue]) }),
        redactor: new Redactor([]),
      },
      target: { jobId: stores.jobs.enqueue({ kind: "issue.labeled", issueId: "issue-1", identifier: "API-1", teamKey: "API", deliveryId: "d-1", description: "", stateType: "started", action: "implement" }), worktreePath: worktree.path, identifier: "API-1", issueId: "issue-1", mode: "create", branch: null, baseSha: repo.sha, loopId: null, port: 4100 },
      branchType: "fix",
    });

    expect(result).toEqual({ ok: true, branch: BRANCH, sha, commits: 1 });
    expect(await git(repo.repo, ["rev-parse", `refs/heads/${BRANCH}`])).toBe(sha);
    expect(await git(evil, ["for-each-ref"])).toBe("");
    expect(markers()).toEqual([]);
  });
});
