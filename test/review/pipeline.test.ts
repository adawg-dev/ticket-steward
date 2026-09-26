import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { BrainInput, BrainRun } from "../../src/brain/types.js";
import type { StewardConfig } from "../../src/config/schema.js";
import type { PipelineDeps } from "../../src/core/deps.js";
import { Redactor } from "../../src/core/redact.js";
import type { RunContext } from "../../src/core/types.js";
import { publishReviewOnly, runReview } from "../../src/review/pipeline.js";
import type { ReviewResult } from "../../src/review/result.js";
import { openStores, type Stores } from "../../src/store/index.js";
import type { ReviewTrigger, TicketBundle } from "../../src/tracker/types.js";
import { commitFile, git } from "../workspace/helpers.js";
import { FakeBrain } from "../fakes/fakeBrain.js";
import { FakeCodeHost } from "../fakes/fakeCodeHost.js";
import { BOT, FakeGitLabReview, fakeMergeRequest } from "../fakes/fakeGitLabReview.js";
import { FakeTracker } from "../fakes/fakeTracker.js";
import { freeTcpPort, tmpRepo, type TmpRepo } from "../fakes/tmpRepo.js";

const REVIEW_PROMPT = "Review {{identifier}} !{{mrIid}} diff={{diffPath}}\n{{#hasRecipe}}RECIPE:{{recipe}}{{/hasRecipe}}{{^hasRecipe}}NO RECIPE{{/hasRecipe}}\n";

const issue = (labels: string[]): TicketBundle => ({
  id: "issue-1", identifier: "API-1", url: "https://linear.app/acme/issue/API-1", title: "Adapter drops the last chunk", description: "d",
  team: { id: "t", key: "API", name: "API" }, state: { name: "In Review", type: "started" }, labels, priority: 2, creator: null,
  createdAt: "2026-09-11T00:00:00.000Z", comments: [], attachments: [], appliedTemplate: null, templates: [],
});

const reviewResult: ReviewResult = {
  verdict: "fixed",
  rerun: { observed: "all chunks arrive", deviations: null },
  summary: "The fix works.",
  comments: [{ path: "src/adapter.ts", line: 1, side: "new", severity: "minor", body: "Name the constant." }],
  confidence: "high",
};

let repo: TmpRepo;
let stores: Stores;
let tracker: FakeTracker;
let api: FakeGitLabReview;
let head: string;
let port: number;

const makeConfig = (): StewardConfig => ({
  dataDir: repo.dataDir,
  brain: { kind: "claude-code", model: "claude-test", maxTurns: 5, timeoutMinutes: 1 },
  tracker: { kind: "linear", teams: ["API"], gatewayIssues: "enrich", bugLabels: ["Bug"] },
  codehost: { kind: "gitlab", baseUrl: "https://gitlab.example", project: "acme/repo" },
  workspace: { fetchUrl: repo.repo, baseBranch: "main", overlayDir: repo.overlayDir, setup: [], setupTimeoutMinutes: 1, port, keepOnFailure: false },
  retention: { keptWorktrees: 3, days: 30 },
  prompt: repo.promptPath,
  server: { port: 3020, publicUrl: "https://steward.example" },
  review: { botUsername: BOT, prompt: join(repo.root, "review.md"), allowForks: false, maxComments: 15 },
});

const makeDeps = (brain: FakeBrain, afterBrain: (input: BrainInput) => Promise<void> | void = () => undefined): PipelineDeps => ({
  config: makeConfig(),
  secrets: { ANTHROPIC_API_KEY: "sk-ant-test-key-value" },
  configPath: join(repo.root, "steward.config.ts"),
  binPath: join(repo.root, "bin", "steward.js"),
  tracker,
  brain,
  codehost: new FakeCodeHost(),
  mirror: repo.mirror,
  stores,
  redactor: new Redactor([]),
  now: () => new Date("2026-09-25T12:00:00.000Z"),
  review: api,
  runBrain: async (_config, input: BrainInput): Promise<BrainRun> => {
    const run = await brain.run(input, () => undefined);
    await afterBrain(input);
    return run;
  },
});

const trigger = (): ReviewTrigger => ({
  kind: "mr.review", deliveryId: "d-1", projectId: 42, projectPath: "acme/repo", mrIid: 7,
  mrUrl: "https://gitlab.example/acme/repo/-/merge_requests/7", headSha: head, linearKey: "API-1", teamKey: "API", reason: "push",
});

const claim = (): RunContext => {
  const t = trigger();
  const jobId = stores.jobs.enqueue(t);
  stores.jobs.claimById(jobId);
  stores.attempts.start(jobId);
  return { jobId, attempt: 1, issueId: t.linearKey, identifier: t.linearKey, teamKey: t.teamKey, trigger: t, dryRun: false };
};

const saveRecipe = async (status: "reproduced" | "not_reproduced"): Promise<void> => {
  const filesDir = join(repo.dataDir, "repros", "1");
  await mkdir(filesDir, { recursive: true });
  await writeFile(join(filesDir, "repro.mjs"), "console.log('repro');\n");
  stores.repros.upsert({
    issueId: "issue-1", identifier: "API-1", jobId: 1, sha: repo.sha, filesDir,
    recipe: { status, method: "script", command: "node repro.mjs", steps: [], files: ["repro.mjs"], expected: "all chunks", observed: "last chunk lost" },
  });
};

beforeEach(async () => {
  repo = await tmpRepo("unused {{ticket}}");
  await writeFile(join(repo.root, "review.md"), REVIEW_PROMPT);
  await git(repo.repo, ["checkout", "-q", "-b", "fix"]);
  head = await commitFile(repo.repo, "src/adapter.ts", "export const adapter = 2;\n");
  await git(repo.repo, ["update-ref", "refs/merge-requests/7/head", head]);
  await git(repo.repo, ["checkout", "-q", "main"]);
  stores = openStores(repo.dataDir);
  tracker = new FakeTracker([issue(["Bug"])]);
  api = new FakeGitLabReview(fakeMergeRequest({ sha: head, diffRefs: { baseSha: repo.sha, startSha: repo.sha, headSha: head } }));
  port = await freeTcpPort();
});

afterEach(async () => {
  stores.db.close();
  await repo.cleanup();
});

describe("runReview", () => {
  it("replays the recipe on the MR head and publishes the review", async () => {
    await saveRecipe("reproduced");
    const seen: { restored: boolean; diff: string } = { restored: false, diff: "" };
    const brain = new FakeBrain({ result: reviewResult });
    const ctx = claim();
    const outcome = await runReview(ctx, makeDeps(brain, async (input) => {
      seen.restored = existsSync(join(input.workspacePath, "repro.mjs"));
      seen.diff = await readFile(join(input.artifactsDir, "mr.diff"), "utf8");
    }));
    expect(outcome).toEqual({ status: "succeeded" });
    expect(brain.lastInput().output).toBe("review");
    expect(brain.lastInput().prompt).toContain("RECIPE:### Reproduction");
    expect(seen.restored).toBe(true);
    expect(seen.diff).toContain("+export const adapter = 2;");
    expect(api.positions).toHaveLength(1);
    expect(api.notes[0]).toContain("**Verdict: fixed.**");
    expect(tracker.comments("issue-1")[0]).toContain("Verified fixed by !7");
    expect(stores.jobs.get(ctx.jobId)?.reviewResult?.result.verdict).toBe("fixed");
  });

  it("posts one unverifiable note and skips the brain when the bug was never reproduced", async () => {
    await saveRecipe("not_reproduced");
    const brain = new FakeBrain({ result: reviewResult });
    const first = await runReview(claim(), makeDeps(brain));
    const second = await runReview(claim(), makeDeps(brain));
    expect(first).toEqual({ status: "succeeded", warning: "skipped: API-1 has no reproduced recipe" });
    expect(second.status).toBe("succeeded");
    expect(brain.runs).toBe(0);
    expect(api.notes).toHaveLength(1);
    expect(api.notes[0]).toContain("The recorded attempt did not reproduce the bug.");
  });

  it("reviews the diff of a non-bug ticket without a recipe", async () => {
    tracker.addIssue(issue(["Feature"]));
    const brain = new FakeBrain({ result: reviewResult });
    expect((await runReview(claim(), makeDeps(brain))).status).toBe("succeeded");
    expect(brain.lastInput().prompt).toContain("NO RECIPE");
    expect(api.notes[0]).toContain("**Verdict: reviewed.**");
    expect(tracker.comments("issue-1")).toHaveLength(0);
  });

  it("skips when the MR head moved on", async () => {
    api.mr = { ...api.mr, sha: "f".repeat(40) };
    const brain = new FakeBrain({ result: reviewResult });
    expect(await runReview(claim(), makeDeps(brain))).toEqual({ status: "succeeded", warning: "skipped: !7 moved on to fffffff" });
    expect(brain.runs).toBe(0);
  });

  it("skips when the steward is no longer a reviewer or the MR is closed", async () => {
    api.mr = { ...api.mr, reviewers: ["ana"] };
    expect((await runReview(claim(), makeDeps(new FakeBrain()))).status).toBe("succeeded");
    api.mr = { ...api.mr, reviewers: [BOT], state: "merged" };
    expect(await runReview(claim(), makeDeps(new FakeBrain()))).toEqual({ status: "succeeded", warning: "skipped: !7 is merged" });
  });

  it("retries while GitLab is still computing the diff", async () => {
    api.mr = { ...api.mr, diffRefs: null };
    expect(await runReview(claim(), makeDeps(new FakeBrain()))).toEqual({ status: "failed", error: "!7 diff is not ready yet", retryable: true });
  });
});

describe("publishReviewOnly", () => {
  it("republishes a stored review without running the brain", async () => {
    const ctx = claim();
    const artifacts = join(repo.dataDir, "jobs", String(ctx.jobId), "artifacts");
    await mkdir(artifacts, { recursive: true });
    await writeFile(join(artifacts, "mr.diff"), "diff --git a/src/adapter.ts b/src/adapter.ts\n--- a/src/adapter.ts\n+++ b/src/adapter.ts\n@@ -1 +1 @@\n-export const adapter = 1;\n+export const adapter = 2;\n");
    stores.jobs.saveReviewResult(ctx.jobId, { result: reviewResult, diffRefs: { baseSha: repo.sha, startSha: repo.sha, headSha: head } });
    const brain = new FakeBrain();
    expect(await publishReviewOnly(ctx, makeDeps(brain))).toEqual({ status: "succeeded" });
    expect(brain.runs).toBe(0);
    expect(api.positions).toHaveLength(1);
  });
});
