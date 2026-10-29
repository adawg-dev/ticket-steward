import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { INTERRUPTED_ERROR } from "../brain/index.js";
import { BOT_USER, type GitLabMrApi, type MergeRequestInfo, type MrDiscussion } from "../codehost/gitlabMr.js";
import { attachedMedia, type MediaUploads } from "../codehost/media.js";
import type { GreptileConfig } from "../config/schema.js";
import type { PipelineDeps } from "../core/deps.js";
import { CLOSED_STATE_TYPES } from "../core/intake.js";
import { readRepoPartial } from "../core/prompt.js";
import type { JobOutcome, RunContext } from "../core/types.js";
import { crashed, errorMessage, jobPaths, jobPort, patchAttempt, prepareFailed, redactOutcome, SetupError, type JobPaths } from "../core/workspace.js";
import { runIdOf, settingsOf, stewardChecks } from "../implement/pipeline.js";
import type { PushTarget } from "../push/target.js";
import { PERSON_COMMITS_MARKER, setupTailOf, STOPPED_JOB_ERROR } from "../run/execute.js";
import { localExecutor } from "../run/local.js";
import type { RunReport, RunSpec, WorkReport } from "../run/protocol.js";
import { transaction, type Loop, type LoopPatch, type LoopRound } from "../store/index.js";
import type { TicketBundle } from "../tracker/types.js";
import { collectCiFailures, type CiFailure } from "./ci.js";
import { renderFixPrompt } from "./prompt.js";
import { publishHandback, publishRoundMedia, publishStop, publishThreads, requestReview } from "./publish.js";
import { validateFixResult, type FixResult, type StoredFix } from "./result.js";
import { findSummary, openFindings, type Finding } from "./summary.js";

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

/** A person's commits between the adopted head and the loop's head, listed by the executor from the worktree's history. */
const personCommits = (loop: Loop): RunSpec["personCommits"] => (loop.adoptedFrom === null ? null : { from: loop.adoptedFrom, to: loop.headSha });

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
  const noted = await publishRoundMedia(deps, reload(fix), result.summary, stored.media);
  if (noted.status !== "succeeded") return noted;
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
  const noted = await publishRoundMedia(fix.deps, fix.loop, result.summary, stored.media);
  if (noted.status !== "succeeded") return noted;
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

/**
 * The decision for a valid result: hand back, or publish a `changed` or `no_changes` round with the media `attach` gives.
 * The steward never commits or pushes for the agent: a change counts only once the push tool pushed it, and work the
 * executor found unpushed hands back.
 */
const handleResult = async (
  fix: Fix,
  work: WorkReport,
  facts: RoundFacts,
  result: FixResult,
  open: number,
  mr: MergeRequestInfo,
  attach: () => Promise<MediaUploads | undefined>,
): Promise<JobOutcome> => {
  // Attached once, before the round is stored: a retry posts the stored embeds and never uploads again.
  const published = async (): Promise<StoredFix> => {
    const media = await attach();
    return { ...facts, result, handback: null, ...(media === undefined ? {} : { media }) };
  };
  if (result.outcome === "failed") return decide(fix, handingBack(facts, result, "the agent could not finish", result.failureDetail ?? ""), mr);
  const leftover = fix.deps.redactor.redact(work.unpushed);
  if (result.outcome === "changed") {
    if (work.pushedSha === null) return decide(fix, handingBack(facts, result, "the agent did not push its change", leftover), mr);
    if (leftover !== "") return decide(fix, handingBack(facts, result, "the agent left unpushed work", leftover), mr);
    return decide(fix, await published(), mr);
  }
  if (work.pushedSha !== null) return decide(fix, handingBack(facts, result, "the agent pushed a change but reported no changes", work.pushedSha), mr);
  if (leftover !== "") return decide(fix, handingBack(facts, result, "the agent left unpushed work", leftover), mr);
  if (open === 0 && facts.pipeline !== "failed") {
    return decide(fix, handingBack(facts, result, `Greptile scored ${facts.score}/5 with nothing open and the agent changed nothing`), mr);
  }
  if (fix.loop.history.at(-1)?.outcome === "no_changes") {
    return decide(fix, handingBack(facts, result, "the agent and Greptile disagree two rounds running", result.summary), mr);
  }
  return decide(fix, await published(), mr);
};

/** A prepared round: the spec to execute, and what its finish judges the result against. */
interface PreparedRound {
  spec: RunSpec;
  facts: RoundFacts;
  findings: Finding[];
}

/**
 * The prepare half of a fresh round: the review's findings, CI failures and people's notes, the prompt, and a spec that
 * resumes the loop's session on its head with the push tool. Either a spec to execute, or the job's outcome.
 */
const prepareFix = async (fix: Fix, observed: Observed): Promise<PreparedRound | { outcome: JobOutcome }> => {
  const { ctx, deps, gitlab, greptile, settings, loop, paths } = fix;
  const { mr, discussions } = observed;
  const summary = findSummary(mr, discussions, greptile.botUsername);
  if (summary === null) return { outcome: await publishHandback(deps, loop, `Greptile has no summary for ${mr.sha.slice(0, 7)}`) };
  const findings = openFindings(discussions, greptile.botUsername);
  const pipeline = mr.headPipeline !== null && mr.headPipeline.sha === mr.sha ? mr.headPipeline : null;
  const facts: RoundFacts = { score: summary.score, reviewCount: summary.reviewCount, pipeline: pipeline?.status ?? null };
  if (loop.sessionId === null) return { outcome: await decide(fix, handingBack(facts, null, SESSION_LOST, "the loop has no stored session"), mr) };

  let ciFailures: CiFailure[] = [];
  // Only a restarted loop reads people's notes, so only it needs to know which account is the steward's.
  let stewardUser: string[] = [];
  try {
    if (pipeline?.status === "failed") ciFailures = await collectCiFailures(gitlab, mr.projectId, pipeline.id, greptile.ciLogLines, deps.redactor);
    if (loop.handedBackAt !== null) stewardUser = [(await gitlab.currentUser()).username];
    await deps.mirror.fetch();
  } catch (err) {
    return { outcome: { status: "failed", error: errorMessage(err), retryable: true } };
  }

  const worktreePath = join(paths.workRoot, paths.worktreeName);
  const commits = personCommits(loop);
  let prompt: string;
  try {
    prompt = renderFixPrompt(await readFile(greptile.prompt, "utf8"), {
      identifier: loop.identifier,
      round: loop.round + 1,
      maxRounds: greptile.maxRounds,
      score: summary.score,
      summary: summary.body,
      findings,
      ciFailures,
      // The executor lists the commits in place of the marker, from the worktree it builds.
      personCommits: commits === null ? [] : [PERSON_COMMITS_MARKER],
      newComments: newNotes(loop, discussions, [greptile.botUsername, ...stewardUser]),
      decisions: loop.decisions,
      workspacePath: worktreePath,
      headSha: loop.headSha,
      stewardPort: jobPort(deps),
      artifactsDir: paths.artifactsDir,
      checks: stewardChecks(settings.checks, loop.baseSha).map((command) => `- \`${command}\``).join("\n"),
      hasChecks: settings.checks.length > 0,
    }, await readRepoPartial(deps.configPath));
  } catch (err) {
    return { outcome: prepareFailed(deps, err) };
  }

  // The agent pushes onto the loop's head through the push tool; the target is fixed here, never chosen by the agent.
  const push: PushTarget = {
    jobId: ctx.jobId, worktreePath, identifier: loop.identifier, issueId: loop.issueId, title: null,
    mode: "fastForward", branch: loop.branch, baseSha: loop.baseSha, loopId: loop.id, port: jobPort(deps),
  };
  const spec: RunSpec = {
    version: 1,
    runId: runIdOf(ctx),
    jobId: ctx.jobId,
    kind: "fix",
    identifier: loop.identifier,
    issueId: loop.issueId,
    checkout: { ref: loop.branch, sha: loop.headSha },
    baseSha: loop.baseSha,
    worktreePath,
    artifactsDir: paths.artifactsDir,
    transcriptPath: paths.transcriptPath,
    prompt,
    personCommits: commits,
    output: "fix",
    resumeSessionId: loop.sessionId,
    limits: { timeoutMinutes: settings.timeoutMinutes, maxTurns: settings.maxTurns, setupTimeoutMinutes: deps.config.workspace.setupTimeoutMinutes },
    push,
    setup: deps.config.workspace.setup,
    checks: stewardChecks(settings.checks, loop.baseSha),
    interactive: false,
  };
  // A reattached run pod already runs this round: what it was started with is what it finishes with.
  return { spec: ctx.resume ?? spec, facts, findings };
};

/** The finish half, from the executor's report and the work it found: retry, hand back, or judge the agent's result. */
const finishFix = async (fix: Fix, prepared: PreparedRound, executed: { report: RunReport; work: WorkReport }, mr: MergeRequestInfo): Promise<JobOutcome> => {
  const { ctx, deps, loop } = fix;
  const { spec, facts, findings } = prepared;
  const { report, work } = executed;
  if (report.setupFailed) {
    patchAttempt(ctx, deps, { setupTail: setupTailOf(report) });
    return report.interrupted ? { status: "failed", error: INTERRUPTED_ERROR, retryable: true } : { status: "failed", error: report.error ?? "setup failed", retryable: true };
  }
  patchAttempt(ctx, deps, { transcriptPath: spec.transcriptPath, ...(report.usage === null ? {} : { usage: report.usage }) });
  // An interrupted run resumes from the session it started from; the partial turn is lost.
  if (report.interrupted) return { status: "failed", error: INTERRUPTED_ERROR, retryable: true };
  if (report.sessionId !== null) {
    deps.stores.loops.update(loop.id, { sessionId: report.sessionId });
    deps.stores.jobs.recordSession(ctx.jobId, report.sessionId);
  }
  // A person stopped it from Linear: handed back, so the next comment or prompt resumes the loop instead of a retry.
  if (report.stopped) return decide(fix, handingBack(facts, null, STOPPED_JOB_ERROR), mr);
  if (!report.ok) {
    const error = report.error ?? "brain run failed";
    return decide(fix, SESSION_ERROR.test(error) ? handingBack(facts, null, SESSION_LOST, error) : handingBack(facts, null, `the agent's run failed: ${error}`), mr);
  }

  const validated = validateFixResult(report.output, findings);
  if (!validated.ok) return decide(fix, handingBack(facts, null, "the agent's result was invalid", validated.error), mr);
  const attach = (): Promise<MediaUploads | undefined> =>
    attachedMedia({ attached: report.media, items: validated.result.media, artifactsDir: spec.artifactsDir, gitlab: fix.gitlab, project: mr.projectId });
  return handleResult(fix, work, facts, validated.result, findings.length, mr, attach);
};

/** A fresh round: prepare, execute (in-process or in a run pod), finish. */
const runRound = async (fix: Fix, observed: Observed): Promise<JobOutcome> => {
  const prepared = await prepareFix(fix, observed);
  if ("outcome" in prepared) return prepared.outcome;
  const { ctx, deps } = fix;
  let executed: { report: RunReport; work: WorkReport };
  try {
    executed = await (deps.executor ?? localExecutor(deps)).execute(prepared.spec, deps.signal);
  } catch (err) {
    if (err instanceof SetupError) patchAttempt(ctx, deps, { setupTail: err.tail });
    return prepareFailed(deps, err);
  }
  return finishFix(fix, prepared, executed, observed.mr);
};

const executeFix = async (ctx: RunContext, deps: PipelineDeps): Promise<JobOutcome> => {
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
    ctx, deps, gitlab, greptile, settings: configured.settings, loop,
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
  const earlier = ctx.resume === undefined ? deps.stores.pushes.latest(ctx.jobId) : null;
  if (earlier !== null) return publishHandback(deps, reload(fix), "an earlier attempt stopped after the agent pushed", earlier.sha);
  return runRound(fix, observed);
};

/** The fix job: resumes the loop's brain session on the review's findings with the push tool, then replies and resolves, or hands back. */
export const runFix = async (ctx: RunContext, deps: PipelineDeps): Promise<JobOutcome> => redactOutcome(await executeFix(ctx, deps).catch(crashed), deps.redactor);
