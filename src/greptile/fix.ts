import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { buildBrainEnv, buildWorkspaceEnv, INTERRUPTED_ERROR, runBrainDetached } from "../brain/index.js";
import type { BrainRun } from "../brain/types.js";
import type { GitLabMrApi, MergeRequestInfo, MrDiscussion } from "../codehost/gitlabMr.js";
import type { GreptileConfig } from "../config/schema.js";
import type { PipelineDeps } from "../core/deps.js";
import { CLOSED_STATE_TYPES } from "../core/intake.js";
import type { JobOutcome, RunContext } from "../core/types.js";
import { brainInput, cleanupWorkspace, crashed, errorMessage, jobPaths, jobPort, patchAttempt, prepareFailed, prepareWorkspace, redactOutcome, sessionsDir, type JobPaths } from "../core/workspace.js";
import { commitWithHooks, guardCommit, installHookWrappers, pushCommit, saveBundle, stageAndGuard } from "../implement/git.js";
import { CHECK_TAIL_BYTES, commitMessage, guardSecrets, settingsOf, stewardChecks, stewardCopies } from "../implement/pipeline.js";
import { transaction, type Loop, type LoopPatch, type LoopRound } from "../store/index.js";
import type { TicketBundle } from "../tracker/types.js";
import { gitOrThrow } from "../workspace/git.js";
import type { RemoteCredentials } from "../workspace/mirror.js";
import { runSetup } from "../workspace/setup.js";
import type { Worktree } from "../workspace/worktree.js";
import { collectCiFailures, type CiFailure } from "./ci.js";
import { renderFixPrompt } from "./prompt.js";
import { publishHandback, publishStop, publishThreads, requestReview } from "./publish.js";
import { validateFixResult, type FixResult, type StoredFix } from "./result.js";
import { findSummary, openFindings } from "./summary.js";

const MINUTE_MS = 60_000;
const FIX_BUNDLE = "fix.bundle";
const PUSH_REPO = "push.git";
const LOOP_MARKER_TEXT = "ticket-steward:loop";
const SESSION_LOST = "the agent's session could not be resumed";
/** The SDK's errors for a session it cannot load or resume. */
const SESSION_ERROR = /no conversation found|resume/i;
/** A push git or the steward's own checks refused, as opposed to one that could not reach the remote. */
const PUSH_REJECTED = /failed to push some refs|refusing to push/;

const fail = (error: string): JobOutcome => ({ status: "failed", error, retryable: false });

/** Everything a fix job works with once its configuration and loop are known. */
interface Fix {
  ctx: RunContext;
  deps: PipelineDeps;
  gitlab: GitLabMrApi;
  greptile: GreptileConfig;
  settings: NonNullable<PipelineDeps["config"]["implement"]>;
  remote: RemoteCredentials;
  loop: Loop;
  paths: JobPaths;
}

interface Observed {
  ticket: TicketBundle;
  mr: MergeRequestInfo;
  discussions: MrDiscussion[];
}

type RoundFacts = Pick<StoredFix, "score" | "reviewCount" | "pipeline">;

const reload = (fix: Fix): Loop => {
  const loop = fix.deps.stores.loops.get(fix.loop.id);
  if (loop === null) throw new Error(`loop ${fix.loop.id} not found`);
  return loop;
};

const observe = async (fix: Fix, projectId: number, mrIid: number): Promise<Observed> => {
  const ticket = await fix.deps.tracker.fetchTicket(fix.loop.issueId);
  const mr = await fix.gitlab.getMergeRequest(projectId, mrIid);
  const discussions = await fix.gitlab.listDiscussions(projectId, mrIid);
  return { ticket, mr, discussions };
};

/** The gate: the ticket is open, the MR is open, and its head is the steward's last push (or the fix commit it pushed). */
const gate = (fix: Fix, observed: Observed): Promise<JobOutcome> | null => {
  const { deps, loop } = fix;
  if (CLOSED_STATE_TYPES.includes(observed.ticket.state.type)) return publishStop(deps, loop, "the ticket was closed", false);
  if (observed.mr.state !== "opened") return publishStop(deps, loop, `the merge request was ${observed.mr.state}`, true);
  const heads = [loop.headSha, ...(loop.pendingPush === null ? [] : [loop.pendingPush.sha])].map((sha) => sha.toLowerCase());
  if (!heads.includes(observed.mr.sha.toLowerCase())) return publishHandback(deps, loop, "a person pushed to the branch; the loop stopped");
  return null;
};

/** GitLab project and group access tokens post as bot users named `project_<id>_bot_<hex>` or `group_<id>_bot_<hex>`. */
const BOT_USER = /^(project|group)_\d+_bot(_[0-9a-f]+)?$/i;

/**
 * MR notes people posted since the loop was last handed back, oldest first: no system notes, nothing from Greptile, a
 * bot user or the steward's own account, and nothing carrying the steward's marker.
 */
const newNotes = (loop: Loop, discussions: MrDiscussion[], skipAuthors: string[]): Array<{ author: string; body: string }> => {
  const since = loop.handedBackAt;
  if (since === null) return [];
  const skipped = new Set(skipAuthors.map((author) => author.toLowerCase()));
  return discussions
    .flatMap((discussion) => discussion.notes)
    .filter((note) => Date.parse(note.createdAt) > Date.parse(since) && !note.system && !note.body.includes(LOOP_MARKER_TEXT))
    .filter((note) => !skipped.has(note.author.toLowerCase()) && !BOT_USER.test(note.author))
    .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt))
    .map(({ author, body }) => ({ author, body }));
};

/** The subjects of a person's commits between the adopted head and the loop's head. */
const personCommits = async (loop: Loop, worktree: Worktree): Promise<string[]> => {
  if (loop.adoptedFrom === null) return [];
  const log = await gitOrThrow(["log", "--format=%s", `${loop.adoptedFrom}..${loop.headSha}`], worktree.path);
  return log.split("\n").filter((line) => line !== "");
};

const round = (loop: Loop, facts: RoundFacts, result: FixResult, outcome: LoopRound["outcome"]): LoopRound => ({
  round: loop.round,
  headSha: loop.headSha,
  score: facts.score,
  pipeline: facts.pipeline,
  fixed: result.threads.filter((thread) => thread.action === "fixed").length,
  declined: result.threads.filter((thread) => thread.action === "declined").length,
  outcome,
});

/** Ends the round: the loop moves on to the next await-review, which starts its wait on its first poll. */
const nextRound = (fix: Fix, patch: LoopPatch, finished: LoopRound): JobOutcome => {
  const { stores } = fix.deps;
  const loop = reload(fix);
  transaction(stores.db, () => {
    stores.loops.update(loop.id, { ...patch, round: loop.round + 1, waitStartedAt: null, state: "awaiting_review" });
    stores.loops.appendRound(loop.id, finished);
    stores.jobs.enqueue({ kind: "loop", issueId: loop.issueId, identifier: loop.identifier, teamKey: loop.teamKey, loopId: loop.id, step: "await" });
  });
  return { status: "succeeded" };
};

/** Pushes the fix commit from the job's bundle in a scratch repo, fast-forward only, leased on the previous head. */
const pushFix = async (fix: Fix, sha: string): Promise<void> => {
  const scratchDir = join(fix.paths.jobDir, PUSH_REPO);
  try {
    await pushCommit({
      scratchDir,
      objectsDir: join(fix.deps.mirror.path, "objects"),
      bundlePath: join(fix.paths.jobDir, FIX_BUNDLE),
      remote: fix.remote,
      sha,
      baseSha: fix.loop.headSha,
      branch: fix.loop.branch,
      identifier: fix.loop.identifier,
      branchTypes: fix.settings.branchTypes,
      mode: { kind: "fastForward", previousHead: fix.loop.headSha },
    });
  } finally {
    await rm(scratchDir, { recursive: true, force: true });
  }
};

/** A `changed` fix: push the pending commit unless it landed, reply and resolve, then move the loop to the new head. */
const publishChanged = async (fix: Fix, stored: StoredFix, result: FixResult, mr: MergeRequestInfo): Promise<JobOutcome> => {
  const { deps, loop } = fix;
  const pending = loop.pendingPush;
  if (pending === null) return fail("no pending fix commit to publish");
  if (!pending.pushed) {
    // The MR already at the fix commit means the push landed before it was recorded.
    if (mr.sha.toLowerCase() !== pending.sha.toLowerCase()) {
      try {
        await pushFix(fix, pending.sha);
      } catch (err) {
        if (PUSH_REJECTED.test(errorMessage(err))) return publishHandback(deps, loop, "the push was rejected", errorMessage(err));
        return { status: "publish_failed", error: `push: ${errorMessage(err)}` };
      }
    }
    deps.stores.loops.update(loop.id, { pendingPush: { sha: pending.sha, pushed: true } });
  }
  const replied = await publishThreads(deps, reload(fix), result, pending.sha);
  if (replied.status !== "succeeded") return replied;
  return nextRound(
    fix,
    { headSha: pending.sha, reviewCountAtTrigger: null, adoptedFrom: null, pendingPush: null },
    round(loop, stored, result, "changed"),
  );
};

/**
 * A `no_changes` fix: reply and resolve, then ask Greptile to review the unchanged head again. The next review is told
 * apart from this one by its `Reviews (N)` counter, so a summary without one hands back before anything is posted.
 */
const publishNoChanges = async (fix: Fix, stored: StoredFix, result: FixResult): Promise<JobOutcome> => {
  if (stored.reviewCount === null) {
    return publishHandback(fix.deps, fix.loop, "Greptile's summary has no review counter, so its next review cannot be told apart", result.summary);
  }
  const replied = await publishThreads(fix.deps, fix.loop, result, null);
  if (replied.status !== "succeeded") return replied;
  const requested = await requestReview(fix.deps, fix.loop);
  if (requested.status !== "succeeded") return requested;
  return nextRound(fix, { reviewCountAtTrigger: stored.reviewCount }, round(fix.loop, stored, result, "no_changes"));
};

/** Publishes what the fix decided; a retry of the job comes straight here, so the brain never runs twice. */
const publishStored = (fix: Fix, stored: StoredFix, mr: MergeRequestInfo): Promise<JobOutcome> => {
  if (stored.handback !== null) return publishHandback(fix.deps, fix.loop, stored.handback.reason, stored.handback.detail);
  const { result } = stored;
  if (result === null) return Promise.resolve(fail("the stored fix has neither a result nor a hand-back"));
  if (result.outcome === "no_changes") return publishNoChanges(fix, stored, result);
  if (result.outcome === "changed") return publishChanged(fix, stored, result, mr);
  return Promise.resolve(fail(`a ${result.outcome} fix must carry a hand-back`));
};

/** Stores the decision before anything is published, then publishes it. */
const decide = (fix: Fix, stored: StoredFix, mr: MergeRequestInfo): Promise<JobOutcome> => {
  fix.deps.stores.jobs.saveFixResult(fix.ctx.jobId, stored);
  return publishStored(fix, stored, mr);
};

const handingBack = (facts: RoundFacts, result: FixResult | null, reason: string, detail = ""): StoredFix => ({
  ...facts,
  result,
  handback: { reason, detail },
});

/** Guards, checks and commits the agent's change on the previous head, bundles it, and records it as the pending push. */
const commitChange = async (fix: Fix, worktree: Worktree, facts: RoundFacts, result: FixResult, mr: MergeRequestInfo): Promise<JobOutcome> => {
  const { ctx, deps, settings, loop, paths } = fix;
  const { files: overlayFiles, secrets } = await guardSecrets(deps.config.workspace.overlayDir, deps.secrets);
  const stewardFiles = await stewardCopies(deps.config.workspace.skillsDir, overlayFiles);
  const guard = await stageAndGuard({ worktreePath: worktree.path, stewardFiles, secretValues: secrets });
  if (!guard.ok) return decide(fix, handingBack(facts, result, guard.reason, guard.detail), mr);

  const workspaceEnv = buildWorkspaceEnv(jobPort(deps));
  // The original base, so a filtered check covers the whole MR and not only this round's commit.
  const checked = await runSetup(stewardChecks(settings.checks, loop.baseSha), worktree.path, workspaceEnv, {
    timeoutMs: settings.checksTimeoutMinutes * MINUTE_MS,
    tailBytes: CHECK_TAIL_BYTES,
    ...(deps.signal === undefined ? {} : { signal: deps.signal }),
  });
  if (deps.signal?.aborted === true) return { status: "failed", error: INTERRUPTED_ERROR, retryable: true };
  if (!checked.ok) return decide(fix, handingBack(facts, result, "the steward's checks failed", deps.redactor.redact(checked.tail)), mr);

  // The brain runs for up to an hour; never commit or push for a ticket that was closed meanwhile.
  let latest: TicketBundle;
  try {
    latest = await deps.tracker.fetchTicket(loop.issueId);
  } catch (err) {
    return { status: "failed", error: errorMessage(err), retryable: true };
  }
  if (CLOSED_STATE_TYPES.includes(latest.state.type)) return publishStop(deps, loop, "the ticket was closed", false);

  const hooksDir = join(paths.jobDir, "hooks");
  await installHookWrappers(worktree.path, hooksDir);
  const committed = await commitWithHooks({
    worktreePath: worktree.path,
    hooksDir,
    messagePath: join(paths.jobDir, "COMMIT_MSG"),
    message: commitMessage(ctx.identifier, result.commitMessage),
    author: settings.commitAuthor,
    env: workspaceEnv,
  });
  if (!committed.ok) return decide(fix, handingBack(facts, result, "kickoff's commit hooks rejected the change", deps.redactor.redact(committed.output)), mr);
  // Exactly one commit whose parent is the previous head, passing the same guard as what was staged.
  const verified = await guardCommit({ worktreePath: worktree.path, baseSha: loop.headSha, sha: committed.sha, stewardFiles, secretValues: secrets });
  if (!verified.ok) return decide(fix, handingBack(facts, result, verified.reason, verified.detail), mr);

  await saveBundle(worktree.path, loop.headSha, join(paths.jobDir, FIX_BUNDLE));
  const stored: StoredFix = { ...facts, result, handback: null };
  // Together, so a retry always finds the commit to push alongside the result whose replies it publishes.
  transaction(deps.stores.db, () => {
    deps.stores.jobs.saveFixResult(ctx.jobId, stored);
    deps.stores.loops.update(loop.id, { pendingPush: { sha: committed.sha, pushed: false } });
  });
  return publishStored({ ...fix, loop: reload(fix) }, stored, mr);
};

/** The decision for a valid result: hand back, publish a `no_changes` round, or commit the change. */
const handleResult = (fix: Fix, worktree: Worktree, facts: RoundFacts, result: FixResult, open: number, mr: MergeRequestInfo): Promise<JobOutcome> => {
  if (result.outcome === "failed") return decide(fix, handingBack(facts, result, "the agent could not finish", result.failureDetail ?? ""), mr);
  if (result.outcome === "changed") return commitChange(fix, worktree, facts, result, mr);
  if (open === 0 && facts.pipeline !== "failed") {
    return decide(fix, handingBack(facts, result, `Greptile scored ${facts.score}/5 with nothing open and the agent changed nothing`), mr);
  }
  if (fix.loop.history.at(-1)?.outcome === "no_changes") {
    return decide(fix, handingBack(facts, result, "the agent and Greptile disagree two rounds running", result.summary), mr);
  }
  return decide(fix, { ...facts, result, handback: null }, mr);
};

/** A fresh round: the workspace at the loop's head, the resumed brain with the review's findings, then its result. */
const runRound = async (fix: Fix, observed: Observed, onWorktree: (worktree: Worktree) => void): Promise<JobOutcome> => {
  const { ctx, deps, gitlab, greptile, settings, loop, paths } = fix;
  const { mr, discussions } = observed;
  const summary = findSummary(mr, discussions, greptile.botUsername);
  if (summary === null) return publishHandback(deps, loop, `Greptile has no summary for ${mr.sha.slice(0, 7)}`);
  const findings = openFindings(discussions, greptile.botUsername);
  const pipeline = mr.headPipeline !== null && mr.headPipeline.sha === mr.sha ? mr.headPipeline : null;
  const facts: RoundFacts = { score: summary.score, reviewCount: summary.reviewCount, pipeline: pipeline?.status ?? null };
  if (loop.sessionId === null) return decide(fix, handingBack(facts, null, SESSION_LOST, "the loop has no stored session"), mr);
  const sessionId = loop.sessionId;

  let ciFailures: CiFailure[] = [];
  // Only a restarted loop reads people's notes, so only it needs to know which account is the steward's.
  let stewardUser: string[] = [];
  try {
    if (pipeline?.status === "failed") ciFailures = await collectCiFailures(gitlab, mr.projectId, pipeline.id, greptile.ciLogLines, deps.redactor);
    if (loop.handedBackAt !== null) stewardUser = [(await gitlab.currentUser()).username];
    await deps.mirror.fetch();
  } catch (err) {
    return { status: "failed", error: errorMessage(err), retryable: true };
  }

  const env = buildBrainEnv(deps.secrets, deps.config.brain, jobPort(deps), sessionsDir(deps.config), deps.config.implement?.commitAuthor);
  let worktree: Worktree;
  let prompt: string;
  try {
    worktree = await prepareWorkspace(ctx, deps, paths, env, loop.headSha, onWorktree);
    prompt = renderFixPrompt(await readFile(greptile.prompt, "utf8"), {
      identifier: loop.identifier,
      round: loop.round + 1,
      maxRounds: greptile.maxRounds,
      score: summary.score,
      summary: summary.body,
      findings,
      ciFailures,
      personCommits: await personCommits(loop, worktree),
      newComments: newNotes(loop, discussions, [greptile.botUsername, ...stewardUser]),
      workspacePath: worktree.path,
      headSha: loop.headSha,
      stewardPort: jobPort(deps),
      artifactsDir: paths.artifactsDir,
      checks: stewardChecks(settings.checks, loop.baseSha).map((command) => `- \`${command}\``).join("\n"),
      hasChecks: settings.checks.length > 0,
    });
  } catch (err) {
    return prepareFailed(deps, err);
  }

  let run: BrainRun;
  try {
    run = await (deps.runBrain ?? runBrainDetached)(
      deps.config.brain,
      brainInput(deps, paths, worktree, prompt, env, "fix", { limits: { timeoutMinutes: settings.timeoutMinutes, maxTurns: settings.maxTurns }, resumeSessionId: sessionId }),
      deps.redactor,
      { ...(deps.signal === undefined ? {} : { signal: deps.signal }) },
    );
  } catch (err) {
    return decide(fix, handingBack(facts, null, "the agent's run failed", errorMessage(err)), mr);
  }
  patchAttempt(ctx, deps, { transcriptPath: paths.transcriptPath, ...(run.usage === undefined ? {} : { usage: run.usage }) });
  // An interrupted run resumes from the session it started from; the partial turn is lost.
  if (!run.ok && run.error === INTERRUPTED_ERROR) return { status: "failed", error: INTERRUPTED_ERROR, retryable: true };
  if (run.sessionId !== undefined) {
    deps.stores.loops.update(loop.id, { sessionId: run.sessionId });
    deps.stores.jobs.recordSession(ctx.jobId, run.sessionId);
  }
  if (!run.ok) {
    const error = run.error ?? "brain run failed";
    return decide(fix, SESSION_ERROR.test(error) ? handingBack(facts, null, SESSION_LOST, error) : handingBack(facts, null, `the agent's run failed: ${error}`), mr);
  }

  const validated = validateFixResult(run.output, findings);
  if (!validated.ok) return decide(fix, handingBack(facts, null, "the agent's result was invalid", validated.error), mr);
  return handleResult(fix, worktree, facts, validated.result, findings.length, mr);
};

const executeFix = async (ctx: RunContext, deps: PipelineDeps, onWorktree: (worktree: Worktree) => void): Promise<JobOutcome> => {
  if (ctx.trigger.kind !== "loop") return fail("fix needs a loop trigger");
  const configured = settingsOf(deps);
  const greptile = deps.config.greptile;
  const gitlab = deps.gitlab;
  if (configured === null || greptile === undefined || gitlab === undefined) {
    return fail("the Greptile loop needs greptile and implement configured, GITLAB_TOKEN and GITLAB_PUSH_TOKEN");
  }
  const loop = deps.stores.loops.get(ctx.trigger.loopId);
  if (loop === null) return fail(`loop ${ctx.trigger.loopId} not found`);
  // A job re-run after its round ended (a crash before the job was marked done) must not fix the round again.
  if (loop.state !== "fixing") return { status: "succeeded", warning: `loop ${loop.id} is ${loop.state}, not fixing` };
  if (loop.projectId === null || loop.mrIid === null) return fail(`loop ${loop.id} has no merge request`);
  const fix: Fix = {
    ctx, deps, gitlab, greptile, settings: configured.settings, remote: configured.remote, loop,
    paths: jobPaths(ctx, deps, { worktreeName: loop.worktreeName }),
  };

  let observed: Observed;
  try {
    observed = await observe(fix, loop.projectId, loop.mrIid);
  } catch (err) {
    return { status: "failed", error: errorMessage(err), retryable: true };
  }
  const stopped = gate(fix, observed);
  if (stopped !== null) return stopped;
  const stored = deps.stores.jobs.get(ctx.jobId)?.fixResult ?? null;
  if (stored !== null) return publishStored(fix, stored, observed.mr);
  return runRound(fix, observed, onWorktree);
};

/** The fix job: resumes the loop's brain session on the review's findings, then pushes, replies and resolves, or hands back. */
export const runFix = async (ctx: RunContext, deps: PipelineDeps): Promise<JobOutcome> => {
  const workspace: { worktree: Worktree | null } = { worktree: null };
  const outcome = redactOutcome(
    await executeFix(ctx, deps, (created) => {
      workspace.worktree = created;
    }).catch(crashed),
    deps.redactor,
  );
  await cleanupWorkspace(deps, workspace.worktree, outcome);
  return outcome;
};
