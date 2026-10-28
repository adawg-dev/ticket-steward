import { readFile } from "node:fs/promises";
import { buildBrainEnv, INTERRUPTED_ERROR, runBrainDetached } from "../brain/index.js";
import type { BrainRun } from "../brain/types.js";
import { BOT_USER, type GitLabMrApi, type MergeRequestInfo, type MrDiscussion } from "../codehost/gitlabMr.js";
import type { GreptileConfig } from "../config/schema.js";
import type { PipelineDeps } from "../core/deps.js";
import { CLOSED_STATE_TYPES } from "../core/intake.js";
import type { JobOutcome, RunContext } from "../core/types.js";
import { brainInput, cleanupWorkspace, crashed, errorMessage, jobPaths, jobPort, patchAttempt, prepareFailed, prepareWorkspace, redactOutcome, sessionsDir, type JobPaths } from "../core/workspace.js";
import { unpushedWork } from "../implement/git.js";
import { guardSecrets, settingsOf, stewardChecks, stewardCopies } from "../implement/pipeline.js";
import { settleUnfinished } from "../push/service.js";
import type { PushTarget } from "../push/target.js";
import { transaction, type Loop, type LoopPatch, type LoopRound, type Push } from "../store/index.js";
import type { TicketBundle } from "../tracker/types.js";
import { gitOrThrow } from "../workspace/git.js";
import type { RemoteCredentials } from "../workspace/mirror.js";
import type { Worktree } from "../workspace/worktree.js";
import { collectCiFailures, type CiFailure } from "./ci.js";
import { renderFixPrompt } from "./prompt.js";
import { publishHandback, publishStop, publishThreads, requestReview } from "./publish.js";
import { validateFixResult, type FixResult, type StoredFix } from "./result.js";
import { findSummary, openFindings } from "./summary.js";

const LOOP_MARKER_TEXT = "ticket-steward:loop";
const SESSION_LOST = "the agent's session could not be resumed";
/** The SDK's errors for a session it cannot load or resume. */
const SESSION_ERROR = /no conversation found|resume/i;

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

/**
 * The gate: the ticket is open, the MR is open, and its head is the loop's last push. The push tool moves `headSha` as
 * its push lands; `pendingPush` covers a push that landed before the tool could record it.
 */
const gate = (fix: Fix, observed: Observed): Promise<JobOutcome> | null => {
  const { deps, loop } = fix;
  if (CLOSED_STATE_TYPES.includes(observed.ticket.state.type)) return publishStop(deps, loop, "the ticket was closed", false);
  if (observed.mr.state !== "opened") return publishStop(deps, loop, `the merge request was ${observed.mr.state}`, true);
  const heads = [loop.headSha, ...(loop.pendingPush === null ? [] : [loop.pendingPush.sha])].map((sha) => sha.toLowerCase());
  if (!heads.includes(observed.mr.sha.toLowerCase())) return publishHandback(deps, loop, "a person pushed to the branch; the loop stopped");
  return null;
};

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

/**
 * The head the round started from. The push tool moves the loop's head mid-run, so once this job pushed, the head it
 * reviewed is the one its first push fast-forwarded from.
 */
const roundHead = (fix: Fix): string => fix.deps.stores.pushes.forJob(fix.ctx.jobId)[0]?.previousSha ?? fix.loop.headSha;

const round = (fix: Fix, facts: RoundFacts, result: FixResult, outcome: LoopRound["outcome"]): LoopRound => ({
  round: fix.loop.round,
  headSha: roundHead(fix),
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

/**
 * A `changed` fix: the agent pushed it through the push tool. Reply and resolve, then move the loop to the pushed head.
 * Never pushes: a push the tool recorded but never marked counts only when the MR is already at its commit.
 */
const publishChanged = async (fix: Fix, stored: StoredFix, result: FixResult, mr: MergeRequestInfo): Promise<JobOutcome> => {
  const { ctx, deps } = fix;
  const loop = reload(fix);
  const pending = loop.pendingPush;
  if (pending === null) return fail("no pending fix commit to publish");
  if (!pending.pushed) {
    if (mr.sha.toLowerCase() !== pending.sha.toLowerCase()) return publishHandback(deps, loop, "the push did not complete", pending.sha);
    const push = deps.stores.pushes.latest(ctx.jobId);
    transaction(deps.stores.db, () => {
      if (push !== null && push.pushedAt === null && push.sha === pending.sha) deps.stores.pushes.markPushed(push.id);
      deps.stores.loops.update(loop.id, { pendingPush: { sha: pending.sha, pushed: true }, headSha: pending.sha });
    });
  }
  const replied = await publishThreads(deps, reload(fix), result, pending.sha);
  if (replied.status !== "succeeded") return replied;
  return nextRound(
    fix,
    { headSha: pending.sha, reviewCountAtTrigger: null, adoptedFrom: null, pendingPush: null },
    round(fix, stored, result, "changed"),
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
  return nextRound(fix, { reviewCountAtTrigger: stored.reviewCount }, round(fix, stored, result, "no_changes"));
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

/** What the agent pushed in this job through the push tool, and what it left behind that never reached the branch. */
interface AgentPushes {
  pushed: Push | null;
  /** Uncommitted paths and commits after the last push (or the round's head), as a `git status`-like summary. */
  leftover: string;
}

const agentPushes = async (fix: Fix, worktree: Worktree, target: PushTarget): Promise<AgentPushes> => {
  const { ctx, deps } = fix;
  // A push the tool recorded but stopped before marking counts when the remote branch is at its commit.
  await settleUnfinished(deps, target, fix.remote);
  const pushed = deps.stores.pushes.latestPushed(ctx.jobId);
  const { files: overlayFiles } = await guardSecrets(deps.config.workspace.overlayDir, deps.secrets);
  const stewardFiles = await stewardCopies(deps.config.workspace.skillsDir, overlayFiles);
  const work = await unpushedWork({ worktreePath: worktree.path, pushedSha: pushed?.sha ?? fix.loop.headSha, stewardFiles });
  return { pushed, leftover: deps.redactor.redact(work.summary) };
};

/**
 * The decision for a valid result: hand back, or publish a `changed` or `no_changes` round. The steward never commits or
 * pushes for the agent: a change counts only once the push tool pushed it, and leftover work hands back.
 */
const handleResult = async (fix: Fix, worktree: Worktree, target: PushTarget, facts: RoundFacts, result: FixResult, open: number, mr: MergeRequestInfo): Promise<JobOutcome> => {
  if (result.outcome === "failed") return decide(fix, handingBack(facts, result, "the agent could not finish", result.failureDetail ?? ""), mr);
  let agent: AgentPushes;
  try {
    agent = await agentPushes(fix, worktree, target);
  } catch (err) {
    return decide(fix, handingBack(facts, result, "the agent's push could not be confirmed", errorMessage(err)), mr);
  }
  if (result.outcome === "changed") {
    if (agent.pushed === null) return decide(fix, handingBack(facts, result, "the agent did not push its change", agent.leftover), mr);
    if (agent.leftover !== "") return decide(fix, handingBack(facts, result, "the agent left unpushed work", agent.leftover), mr);
    return decide(fix, { ...facts, result, handback: null }, mr);
  }
  if (agent.pushed !== null) return decide(fix, handingBack(facts, result, "the agent pushed a change but reported no changes", agent.pushed.sha), mr);
  if (agent.leftover !== "") return decide(fix, handingBack(facts, result, "the agent left unpushed work", agent.leftover), mr);
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

  // The agent pushes onto the loop's head through the push tool; the target is fixed here, never chosen by the agent.
  const push: PushTarget = {
    jobId: ctx.jobId, worktreePath: worktree.path, identifier: loop.identifier, issueId: loop.issueId,
    mode: "fastForward", branch: loop.branch, baseSha: loop.baseSha, loopId: loop.id, port: jobPort(deps),
  };
  let run: BrainRun;
  try {
    run = await (deps.runBrain ?? runBrainDetached)(
      deps.config.brain,
      brainInput(deps, paths, worktree, prompt, env, "fix", { limits: { timeoutMinutes: settings.timeoutMinutes, maxTurns: settings.maxTurns }, resumeSessionId: sessionId, push }),
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
  return handleResult(fix, worktree, push, facts, validated.result, findings.length, mr);
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
  // A rerun after the agent pushed (the attempt was interrupted later) never runs the brain again over its own push.
  const earlier = deps.stores.pushes.latest(ctx.jobId);
  if (earlier !== null) return publishHandback(deps, reload(fix), "an earlier attempt stopped after the agent pushed", earlier.sha);
  return runRound(fix, observed, onWorktree);
};

/** The fix job: resumes the loop's brain session on the review's findings with the push tool, then replies and resolves, or hands back. */
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
