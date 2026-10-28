import { mkdir, readFile } from "node:fs/promises";
import Mustache from "mustache";
import { buildBrainEnv, INTERRUPTED_ERROR, runBrainDetached } from "../brain/index.js";
import type { BrainRun } from "../brain/types.js";
import { chatPromptPath } from "../cli/paths.js";
import type { GitLabMrApi } from "../codehost/gitlabMr.js";
import type { PipelineDeps } from "../core/deps.js";
import type { JobOutcome, RunContext } from "../core/types.js";
import { brainInput, cleanupWorkspace, crashed, errorMessage, jobPaths, jobPort, patchAttempt, prepareFailed, redactOutcome, sessionsDir, startSlot } from "../core/workspace.js";
import { unpushedWork } from "../implement/git.js";
import { guardSecrets, settingsOf, stewardChecks, stewardCopies } from "../implement/pipeline.js";
import type { PushTarget } from "../push/target.js";
import type { TriggerEvent } from "../tracker/types.js";
import { logger } from "../log.js";
import type { Worktree } from "../workspace/worktree.js";
import { CHAT_MARKER, NO_SESSION_REPLY, validateChatResult, type StoredChat } from "./result.js";
import { ensureWorktree, latestSession, type AgentSession } from "./session.js";

const { render } = Mustache;

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
}

const verbatim = (value: string): string => value;

/** Fill the chat prompt template (mustache, unescaped, like the other prompts). */
export const renderChatPrompt = (template: string, input: ChatPromptInput): string => render(template, input, undefined, { escape: verbatim });

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

/** The brain run: the worktree and slot ready, the session resumed with the message, its reply stored and posted. */
const converse = async (ctx: RunContext, deps: PipelineDeps, gitlab: GitLabMrApi, trigger: ChatTrigger, session: AgentSession): Promise<JobOutcome> => {
  const port = jobPort(deps);
  const env = buildBrainEnv(deps.secrets, deps.config.brain, port, sessionsDir(deps.config), deps.config.implement?.commitAuthor);
  const paths = jobPaths(ctx, deps, { worktreeName: session.worktreeName });
  const settings = deps.config.implement;
  let worktree: Worktree;
  let prompt: string;
  let push: PushTarget | undefined;
  try {
    const mr = await gitlab.getMergeRequest(trigger.projectId, trigger.mrIid);
    const slot = await startSlot(ctx, deps, port);
    await mkdir(paths.artifactsDir, { recursive: true, mode: 0o700 });
    worktree = await ensureWorktree(deps, session, { env, port, slot });
    push = sessionPushTarget(deps, session, worktree, {
      jobId: session.loopId === null ? session.jobId : ctx.jobId, identifier: ctx.identifier, issueId: ctx.issueId, port,
    });
    const checks = push === undefined || settings === undefined ? [] : stewardChecks(settings.checks, push.baseSha);
    prompt = renderChatPrompt(await readFile(chatPromptPath, "utf8"), {
      identifier: ctx.identifier,
      author: trigger.author,
      message: trigger.message,
      mrUrl: mr.webUrl,
      workspacePath: worktree.path,
      headSha: worktree.sha,
      stewardPort: port,
      artifactsDir: paths.artifactsDir,
      canPush: push !== undefined,
      branch: session.branch ?? "",
      checks: checks.map((command) => `- \`${command}\``).join("\n"),
      hasChecks: checks.length > 0,
    });
  } catch (err) {
    return prepareFailed(deps, err);
  }

  let run: BrainRun;
  try {
    run = await (deps.runBrain ?? runBrainDetached)(
      deps.config.brain,
      brainInput(deps, paths, worktree, prompt, env, "chat", { resumeSessionId: session.sessionId, ...(push === undefined ? {} : { push }) }),
      deps.redactor,
      { ...(deps.signal === undefined ? {} : { signal: deps.signal }) },
    );
  } catch (err) {
    return decide(ctx, deps, gitlab, trigger, { reply: "The agent could not answer: its run failed to start.", warning: `the agent's run failed: ${errorMessage(err)}` });
  }
  patchAttempt(ctx, deps, { transcriptPath: paths.transcriptPath, ...(run.usage === undefined ? {} : { usage: run.usage }) });
  // An interrupted run resumes from the session it started from; the partial turn is lost.
  if (!run.ok && run.error === INTERRUPTED_ERROR) return { status: "failed", error: INTERRUPTED_ERROR, retryable: true };
  if (run.sessionId !== undefined) {
    // The next chat, fix round or `steward chat` resumes where this one ended.
    if (session.loopId !== null) deps.stores.loops.update(session.loopId, { sessionId: run.sessionId });
    else deps.stores.jobs.recordSession(session.jobId, run.sessionId);
    deps.stores.jobs.recordSession(ctx.jobId, run.sessionId);
  }
  const leftover = await leftoverWork(deps, session, worktree, push);
  if (!run.ok) {
    const error = run.error ?? "brain run failed";
    const reply = SESSION_ERROR.test(error) ? "The agent's session could not be resumed." : "The agent could not answer: its run failed.";
    return decide(ctx, deps, gitlab, trigger, { reply: withLeftover(reply, leftover), warning: `the agent's run failed: ${deps.redactor.redact(error)}` });
  }
  const validated = validateChatResult(run.output);
  if (!validated.ok) {
    return decide(ctx, deps, gitlab, trigger, { reply: withLeftover("The agent's answer could not be read.", leftover), warning: `the agent's result was invalid: ${validated.error}` });
  }
  return decide(ctx, deps, gitlab, trigger, { reply: withLeftover(validated.result.reply, leftover), warning: leftover === "" ? null : "the agent left unpushed work" });
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
 * with the note's message, then posts the agent's reply in the note's discussion. The worktree is the session's, so it is
 * kept; only the port and slot are freed.
 */
export const runChat = async (ctx: RunContext, deps: PipelineDeps): Promise<JobOutcome> => {
  const outcome = redactOutcome(await executeChat(ctx, deps).catch(crashed), deps.redactor);
  await cleanupWorkspace(deps, null, outcome);
  return outcome;
};
