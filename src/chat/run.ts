import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { INTERRUPTED_ERROR } from "../brain/index.js";
import { chatPromptPath } from "../cli/paths.js";
import type { GitLabMrApi } from "../codehost/gitlabMr.js";
import { attachedMedia, renderMedia } from "../codehost/media.js";
import type { PipelineDeps } from "../core/deps.js";
import { readRepoPartial, renderPrompt } from "../core/prompt.js";
import type { JobOutcome, RunContext } from "../core/types.js";
import { crashed, errorMessage, jobPaths, jobPort, patchAttempt, prepareFailed, redactOutcome, SetupError } from "../core/workspace.js";
import { unpushedWork } from "../implement/git.js";
import { guardSecrets, runIdOf, settingsOf, stewardChecks, stewardCopies } from "../implement/pipeline.js";
import type { PushTarget } from "../push/target.js";
import { setupTailOf } from "../run/execute.js";
import { localExecutor } from "../run/local.js";
import type { RunReport, RunSpec, WorkReport } from "../run/protocol.js";
import type { TriggerEvent } from "../tracker/types.js";
import { logger } from "../log.js";
import type { Worktree } from "../workspace/worktree.js";
import { CHAT_MARKER, NO_SESSION_REPLY, validateChatResult, type StoredChat } from "./result.js";
import { latestSession, type AgentSession } from "./session.js";

/** The SDK's errors for a session it cannot load or resume. */
const SESSION_ERROR = /no conversation found|resume/i;

type ChatTrigger = Extract<TriggerEvent, { kind: "chat" }>;

const fail = (error: string): JobOutcome => ({ status: "failed", error, retryable: false });

export interface ChatPromptInput {
  identifier: string;
  author: string;
  message: string;
  mrUrl: string;
  workspacePath: string;
  headSha: string;
  stewardPort: number;
  artifactsDir: string;
  /** The run has the push tool: the ticket has a pushed steward branch. */
  canPush: boolean;
  branch: string;
  /** implement.checks as a Markdown list. */
  checks: string;
  hasChecks: boolean;
  /** The loop's decisions so far, so the agent neither records them again nor contradicts them. */
  decisions: string[];
}

/** Fill the chat prompt template (mustache, unescaped, like the other prompts), with the repo's own section as `{{> repo}}`. */
export const renderChatPrompt = (template: string, input: ChatPromptInput, repo = ""): string =>
  renderPrompt(template, { ...input, hasDecisions: input.decisions.length > 0 }, repo);

/** Posts the stored reply with the marker, in the note's discussion (or on the MR when GitLab gave no discussion). */
const postReply = async (deps: PipelineDeps, gitlab: GitLabMrApi, trigger: ChatTrigger, stored: StoredChat): Promise<JobOutcome> => {
  const body = deps.redactor.redact(`${stored.reply}\n\n${CHAT_MARKER}`);
  try {
    if (trigger.discussionId === null) await gitlab.createNote(trigger.projectId, trigger.mrIid, body);
    else await gitlab.replyToDiscussion(trigger.projectId, trigger.mrIid, trigger.discussionId, body);
  } catch (err) {
    return { status: "publish_failed", error: `chat reply: ${errorMessage(err)}` };
  }
  return stored.warning === null ? { status: "succeeded" } : { status: "succeeded", warning: stored.warning };
};

/** Stores the reply before it is posted, then posts it; a retry of the job posts the stored one. */
const decide = (ctx: RunContext, deps: PipelineDeps, gitlab: GitLabMrApi, trigger: ChatTrigger, stored: StoredChat): Promise<JobOutcome> => {
  deps.stores.jobs.saveChatResult(ctx.jobId, stored);
  return postReply(deps, gitlab, trigger, stored);
};

/** The original base the session's branch grew from: the loop's, else the implement job's. */
const baseShaOf = (deps: Pick<PipelineDeps, "stores">, session: AgentSession): string | null =>
  session.loopId !== null ? (deps.stores.loops.get(session.loopId)?.baseSha ?? null) : (deps.stores.jobs.get(session.jobId)?.baseSha ?? null);

/**
 * The push tool's target, only when the ticket has a pushed steward branch. A loop's chat pushes onto the loop's head like a
 * fix round. Without a loop the push is recorded on the implement job, whose last push is the branch head, so the next
 * chat (and `latestSession`) starts from what this one pushed. `jobId` is the job the push is recorded on: a chat job's
 * own on a loop, the session's implement job otherwise (and always for `steward chat`, which has no job).
 */
export const sessionPushTarget = (
  deps: Pick<PipelineDeps, "config" | "secrets" | "stores">,
  session: AgentSession,
  worktree: Pick<Worktree, "path">,
  run: { jobId: number; identifier: string; issueId: string; port: number },
): PushTarget | undefined => {
  if (session.branch === null || settingsOf(deps) === null) return undefined;
  const baseSha = baseShaOf(deps, session);
  if (baseSha === null) return undefined;
  return {
    jobId: run.jobId, worktreePath: worktree.path, identifier: run.identifier, issueId: run.issueId,
    mode: "fastForward", branch: session.branch, baseSha, loopId: session.loopId, port: run.port,
  };
};

/** The branch head the store holds after the run: the loop's, or the implement job's last push. */
const branchHead = (deps: Pick<PipelineDeps, "stores">, session: AgentSession): string | null =>
  session.loopId !== null ? (deps.stores.loops.get(session.loopId)?.headSha ?? null) : (deps.stores.jobs.get(session.jobId)?.commitSha ?? null);

/**
 * What the run left that never reached the branch: uncommitted paths and commits after the branch head (or, answer-only,
 * after the commit the run started at). The steward never commits or pushes it; the reply says so.
 */
export const leftoverWork = async (deps: Pick<PipelineDeps, "config" | "stores" | "secrets" | "redactor">, session: AgentSession, worktree: Worktree, push: PushTarget | undefined): Promise<string> => {
  try {
    const pushedSha = (push === undefined ? null : branchHead(deps, session)) ?? worktree.sha;
    const { files: overlayFiles } = await guardSecrets(deps.config.workspace.overlayDir, deps.secrets);
    const stewardFiles = await stewardCopies(deps.config.workspace.skillsDir, overlayFiles);
    return deps.redactor.redact((await unpushedWork({ worktreePath: worktree.path, pushedSha, stewardFiles })).summary);
  } catch (err) {
    logger.warn({ err: errorMessage(err) }, "chat: unpushed work could not be read");
    return "";
  }
};

const withLeftover = (reply: string, leftover: string): string =>
  leftover === "" ? reply : `${reply}\n\nLeft in the agent's worktree, not pushed:\n\n\`\`\`\n${leftover}\n\`\`\``;

/**
 * The prepare half: the MR, the push target and the prompt, and a spec that resumes the session in its worktree, on the
 * pushed branch head (else the implement job's base). Either a spec to execute, or the job's outcome.
 */
const prepareChat = async (ctx: RunContext, deps: PipelineDeps, gitlab: GitLabMrApi, trigger: ChatTrigger, session: AgentSession): Promise<{ spec: RunSpec } | { outcome: JobOutcome }> => {
  if (ctx.resume !== undefined) return { spec: ctx.resume };
  const port = jobPort(deps);
  const paths = jobPaths(ctx, deps, { worktreeName: session.worktreeName });
  const worktreePath = join(paths.workRoot, paths.worktreeName);
  const settings = deps.config.implement;
  const push = sessionPushTarget(deps, session, { path: worktreePath }, {
    jobId: session.loopId === null ? session.jobId : ctx.jobId, identifier: ctx.identifier, issueId: ctx.issueId, port,
  });
  const checks = push === undefined || settings === undefined ? [] : stewardChecks(settings.checks, push.baseSha);
  let prompt: string;
  try {
    const mr = await gitlab.getMergeRequest(trigger.projectId, trigger.mrIid);
    prompt = renderChatPrompt(await readFile(chatPromptPath, "utf8"), {
      identifier: ctx.identifier,
      author: trigger.author,
      message: trigger.message,
      mrUrl: mr.webUrl,
      workspacePath: worktreePath,
      headSha: session.headSha,
      stewardPort: port,
      artifactsDir: paths.artifactsDir,
      canPush: push !== undefined,
      branch: session.branch ?? "",
      checks: checks.map((command) => `- \`${command}\``).join("\n"),
      hasChecks: checks.length > 0,
      decisions: session.loopId === null ? [] : (deps.stores.loops.get(session.loopId)?.decisions ?? []),
    }, await readRepoPartial(deps.configPath));
  } catch (err) {
    return { outcome: prepareFailed(deps, err) };
  }
  const spec: RunSpec = {
    version: 1,
    runId: runIdOf(ctx),
    jobId: ctx.jobId,
    kind: "chat",
    identifier: ctx.identifier,
    issueId: ctx.issueId,
    checkout: { ref: session.branch, sha: session.headSha },
    baseSha: baseShaOf(deps, session) ?? session.headSha,
    worktreePath,
    artifactsDir: paths.artifactsDir,
    transcriptPath: paths.transcriptPath,
    prompt,
    personCommits: null,
    output: "chat",
    resumeSessionId: session.sessionId,
    limits: { timeoutMinutes: deps.config.brain.timeoutMinutes, maxTurns: deps.config.brain.maxTurns, setupTimeoutMinutes: deps.config.workspace.setupTimeoutMinutes },
    push: push ?? null,
    setup: deps.config.workspace.setup,
    checks,
    interactive: false,
  };
  return { spec };
};

/**
 * The spec of `steward chat`'s interactive run on Kubernetes: the session resumed in its worktree, in a run pod a person
 * attaches to. No job runs it (job id 0); like the terminal chat, its pushes are recorded on the session's implement job.
 */
export const interactiveChatSpec = (
  deps: Pick<PipelineDeps, "config" | "secrets" | "stores">,
  p: { runId: string; ticket: { id: string; identifier: string }; session: AgentSession },
): RunSpec => {
  const { config } = deps;
  const { session, ticket } = p;
  const worktreePath = join(config.dataDir, "work", session.worktreeName);
  const jobDir = join(config.dataDir, "jobs", `chat-${ticket.identifier}`);
  const push = sessionPushTarget(deps, session, { path: worktreePath }, { jobId: session.jobId, identifier: ticket.identifier, issueId: ticket.id, port: jobPort({ config }) });
  const checks = push === undefined || config.implement === undefined ? [] : stewardChecks(config.implement.checks, push.baseSha);
  return {
    version: 1,
    runId: p.runId,
    jobId: 0,
    kind: "chat",
    identifier: ticket.identifier,
    issueId: ticket.id,
    checkout: { ref: session.branch, sha: session.headSha },
    baseSha: baseShaOf(deps, session) ?? session.headSha,
    worktreePath,
    artifactsDir: join(jobDir, "artifacts"),
    transcriptPath: join(jobDir, "transcript.jsonl"),
    prompt: "",
    personCommits: null,
    output: "chat",
    resumeSessionId: session.sessionId,
    limits: { timeoutMinutes: config.brain.timeoutMinutes, maxTurns: config.brain.maxTurns, setupTimeoutMinutes: config.workspace.setupTimeoutMinutes },
    push: push ?? null,
    setup: config.workspace.setup,
    checks,
    interactive: true,
  };
};

/**
 * Adds the decisions the person gave to the session's loop, which shows them to every later fix round and chat. A ticket
 * with no loop has no round to show them to, so they are not kept. Recorded before the reply is stored: a retry that runs
 * the brain again finds them already there.
 */
const recordDecisions = (deps: Pick<PipelineDeps, "stores" | "redactor">, session: AgentSession, decisions: string[]): void => {
  if (decisions.length === 0) return;
  if (session.loopId === null) {
    logger.info({ count: decisions.length }, "chat: decisions not kept, the ticket has no loop");
    return;
  }
  try {
    deps.stores.loops.appendDecisions(session.loopId, decisions.map((decision) => deps.redactor.redact(decision)));
  } catch (err) {
    logger.warn({ loopId: session.loopId, err: errorMessage(err) }, "chat: decisions could not be recorded");
  }
};

/** The reply with the screenshots and recordings the run attached, if any. */
const withMedia = (reply: string, media: string[]): string => (media.length === 0 ? reply : `${reply}\n\n${media.join("\n")}`);

/**
 * The finish half, from the executor's report and the work it found: retry, or store and post the reply with the media
 * the agent attached and what was left unpushed.
 */
const finishChat = async (
  ctx: RunContext,
  deps: PipelineDeps,
  gitlab: GitLabMrApi,
  trigger: ChatTrigger,
  session: AgentSession,
  spec: RunSpec,
  executed: { report: RunReport; work: WorkReport },
): Promise<JobOutcome> => {
  const { report, work } = executed;
  if (report.setupFailed) {
    patchAttempt(ctx, deps, { setupTail: setupTailOf(report) });
    return report.interrupted ? { status: "failed", error: INTERRUPTED_ERROR, retryable: true } : { status: "failed", error: report.error ?? "setup failed", retryable: true };
  }
  patchAttempt(ctx, deps, { transcriptPath: spec.transcriptPath, ...(report.usage === null ? {} : { usage: report.usage }) });
  // An interrupted run resumes from the session it started from; the partial turn is lost.
  if (report.interrupted) return { status: "failed", error: INTERRUPTED_ERROR, retryable: true };
  if (report.sessionId !== null) {
    // The next chat, fix round or `steward chat` resumes where this one ended.
    if (session.loopId !== null) deps.stores.loops.update(session.loopId, { sessionId: report.sessionId });
    else deps.stores.jobs.recordSession(session.jobId, report.sessionId);
    deps.stores.jobs.recordSession(ctx.jobId, report.sessionId);
  }
  const leftover = deps.redactor.redact(work.unpushed);
  if (!report.ok) {
    const error = report.error ?? "brain run failed";
    const reply = SESSION_ERROR.test(error) ? "The agent's session could not be resumed." : "The agent could not answer: its run failed.";
    return decide(ctx, deps, gitlab, trigger, { reply: withLeftover(reply, leftover), warning: `the agent's run failed: ${deps.redactor.redact(error)}` });
  }
  const validated = validateChatResult(report.output);
  if (!validated.ok) {
    return decide(ctx, deps, gitlab, trigger, { reply: withLeftover("The agent's answer could not be read.", leftover), warning: `the agent's result was invalid: ${validated.error}` });
  }
  recordDecisions(deps, session, validated.result.decisions);
  const media = renderMedia(await attachedMedia({ attached: report.media, items: validated.result.media, artifactsDir: spec.artifactsDir, gitlab, project: trigger.projectId }));
  const reply = withLeftover(withMedia(validated.result.reply, media), leftover);
  return decide(ctx, deps, gitlab, trigger, { reply, warning: leftover === "" ? null : "the agent left unpushed work" });
};

/** The brain run: prepare, execute (in-process or in a run pod), finish. */
const converse = async (ctx: RunContext, deps: PipelineDeps, gitlab: GitLabMrApi, trigger: ChatTrigger, session: AgentSession): Promise<JobOutcome> => {
  const prepared = await prepareChat(ctx, deps, gitlab, trigger, session);
  if ("outcome" in prepared) return prepared.outcome;
  let executed: { report: RunReport; work: WorkReport };
  try {
    executed = await (deps.executor ?? localExecutor(deps)).execute(prepared.spec, deps.signal);
  } catch (err) {
    if (err instanceof SetupError) patchAttempt(ctx, deps, { setupTail: err.tail });
    return prepareFailed(deps, err);
  }
  return finishChat(ctx, deps, gitlab, trigger, session, prepared.spec, executed);
};

const executeChat = async (ctx: RunContext, deps: PipelineDeps): Promise<JobOutcome> => {
  if (ctx.trigger.kind !== "chat") return fail("chat needs a chat trigger");
  const trigger = ctx.trigger;
  const gitlab = deps.gitlab;
  if (gitlab === undefined || deps.config.codehost.kind !== "gitlab") return fail("chat needs a GitLab code host and GITLAB_TOKEN");
  const stored = deps.stores.jobs.get(ctx.jobId)?.chatResult ?? null;
  if (stored !== null) return postReply(deps, gitlab, trigger, stored);
  if (deps.config.brain.kind !== "claude-code") return fail('chat requires brain.kind "claude-code"');
  const session = latestSession(deps.stores, ctx.issueId);
  if (session === null) return decide(ctx, deps, gitlab, trigger, { reply: NO_SESSION_REPLY, warning: "the ticket has no agent session" });
  return converse(ctx, deps, gitlab, trigger, session);
};

/**
 * The chat job: resumes the ticket's latest agent session in its worktree (recreated at the same path if it was swept)
 * with the note's message, then posts the agent's reply in the note's discussion. The worktree is the session's, so the
 * executor keeps it; only the port and slot are freed.
 */
export const runChat = async (ctx: RunContext, deps: PipelineDeps): Promise<JobOutcome> => redactOutcome(await executeChat(ctx, deps).catch(crashed), deps.redactor);
