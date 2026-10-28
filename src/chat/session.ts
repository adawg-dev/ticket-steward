import { join } from "node:path";
import { DEFAULT_SESSION_RETENTION_DAYS, type StewardConfig } from "../config/schema.js";
import type { PipelineDeps } from "../core/deps.js";
import { furnishWorktree, MINUTE_MS, SETUP_TAIL_BYTES } from "../core/workspace.js";
import type { Stores } from "../store/index.js";
import { git } from "../workspace/git.js";
import type { Mirror } from "../workspace/mirror.js";
import { loopProtection, sessionProjectDir } from "../workspace/retention.js";
import { runSetup } from "../workspace/setup.js";
import type { Slot } from "../workspace/slots.js";
import { createWorktree, openWorktree, type Worktree } from "../workspace/worktree.js";

const DAY_MS = 24 * 60 * 60 * 1000;

/** The brain session a chat resumes, and the worktree (path and commit) it must run in for `--resume` to find it. */
export interface AgentSession {
  sessionId: string;
  worktreeName: string;
  /** The commit to recreate the worktree at: the pushed branch head, else the implement job's base. */
  headSha: string;
  /** The ticket's pushed steward branch; null when nothing was pushed (answer-only chat). */
  branch: string | null;
  loopId: number | null;
  /** The loop's implement job, or the implement job whose session this is. */
  jobId: number;
}

/**
 * The ticket's latest session: its loop's when the latest loop has one, else the newest implement job's that recorded its
 * worktree. A job counts its commit as the head only once the push landed; before that its base is all the mirror has.
 */
export const latestSession = (stores: Pick<Stores, "jobs" | "loops">, issueId: string): AgentSession | null => {
  const loop = stores.loops.latestForIssue(issueId);
  if (loop !== null && loop.sessionId !== null) {
    return { sessionId: loop.sessionId, worktreeName: loop.worktreeName, headSha: loop.headSha, branch: loop.branch, loopId: loop.id, jobId: loop.implementJobId };
  }
  const job = stores.jobs.latestImplementSession(issueId);
  if (job === null || job.sessionId === null || job.worktreeName === null) return null;
  const pushed = job.pushedAt !== null && job.commitSha !== null && job.branch !== null;
  const headSha = pushed ? job.commitSha : job.baseSha;
  if (headSha === null) return null;
  return { sessionId: job.sessionId, worktreeName: job.worktreeName, headSha, branch: pushed ? job.branch : null, loopId: null, jobId: job.id };
};

/**
 * Moves a reused worktree up to `headSha` when that is safe: no tracked changes and HEAD an ancestor of it (behind, not
 * ahead or diverged). Anything else stays exactly as it is; a checkout git refuses (an untracked file in the way) too.
 */
const catchUp = async (mirror: Mirror, worktree: Worktree, headSha: string): Promise<Worktree> => {
  if (worktree.sha === headSha) return worktree;
  const status = await git(["status", "--porcelain", "--untracked-files=no"], worktree.path);
  if (status.exitCode !== 0 || status.stdout !== "") return worktree;
  if ((await git(["cat-file", "-e", `${headSha}^{commit}`], worktree.path)).exitCode !== 0) await mirror.fetch();
  if ((await git(["merge-base", "--is-ancestor", worktree.sha, headSha], worktree.path)).exitCode !== 0) return worktree;
  const moved = await git(["checkout", "--quiet", "--detach", headSha], worktree.path);
  return moved.exitCode === 0 ? { ...worktree, sha: headSha } : worktree;
};

/**
 * The session's worktree, its steward files laid in for a run on `placement`'s port and slot. An existing one is reused
 * with its changes (caught up to the head only when clean and behind); a missing one is recreated at the same path
 * (sessions are keyed by path) at `headSha` after a fetch, and `created` says it still needs `workspace.setup`.
 */
export const sessionWorktree = async (
  deps: Pick<PipelineDeps, "config" | "mirror" | "redactor" | "signal">,
  session: Pick<AgentSession, "worktreeName" | "headSha">,
  placement: { env: Record<string, string>; port: number; slot: Slot | null },
): Promise<{ worktree: Worktree; created: boolean }> => {
  const workRoot = join(deps.config.dataDir, "work");
  const existing = await openWorktree(deps.mirror, workRoot, session.worktreeName);
  const furnish = (worktree: Worktree): Promise<unknown> =>
    furnishWorktree(deps, worktree.path, placement.env, { port: placement.port, slot: placement.slot, setup: false });
  if (existing !== null) {
    const worktree = await catchUp(deps.mirror, existing, session.headSha);
    await furnish(worktree);
    return { worktree, created: false };
  }
  await deps.mirror.fetch();
  const worktree = await createWorktree(deps.mirror, workRoot, session.worktreeName, session.headSha);
  await furnish(worktree);
  return { worktree, created: true };
};

/** `sessionWorktree`, with `workspace.setup` run in a recreated one (`steward chat`, which runs no executor). */
export const ensureWorktree = async (
  deps: Pick<PipelineDeps, "config" | "mirror" | "redactor" | "signal">,
  session: Pick<AgentSession, "worktreeName" | "headSha">,
  placement: { env: Record<string, string>; port: number; slot: Slot | null },
): Promise<Worktree> => {
  const { worktree, created } = await sessionWorktree(deps, session, placement);
  if (!created) return worktree;
  const setup = await runSetup(deps.config.workspace.setup, worktree.path, placement.env, {
    timeoutMs: deps.config.workspace.setupTimeoutMinutes * MINUTE_MS,
    tailBytes: SETUP_TAIL_BYTES,
    ...(deps.signal === undefined ? {} : { signal: deps.signal }),
  });
  if (!setup.ok) throw new Error(`setup failed:\n${deps.redactor.redact(setup.tail)}`);
  return worktree;
};

export const sessionRetentionDays = (config: Pick<StewardConfig, "chat">): number => config.chat?.sessionRetentionDays ?? DEFAULT_SESSION_RETENTION_DAYS;

/**
 * What retention must keep: loop worktrees and their sessions within `retention.days` (as before), the worktree and session
 * of every open `steward chat` (its lease), plus the session dirs of every loop or job session whose ticket was active
 * within `sessionRetentionDays`. Worktree eviction is otherwise unchanged.
 */
export const retentionProtection = (
  stores: Pick<Stores, "jobs" | "loops" | "leases">,
  config: Pick<StewardConfig, "dataDir" | "retention" | "chat">,
  now: Date = new Date(),
): { protect: string[]; protectSessionPaths: string[] } => {
  const workRoot = join(config.dataDir, "work");
  const loops = loopProtection(workRoot, stores.loops.keptWithin(config.retention.days));
  const chats = stores.leases.active(now).map((lease) => join(workRoot, lease.worktreeName));
  const since = new Date(now.getTime() - sessionRetentionDays(config) * DAY_MS);
  const sessions = [...stores.loops.sessionWorktreesActiveSince(since), ...stores.jobs.sessionWorktreesActiveSince(since)].map((name) =>
    sessionProjectDir(join(workRoot, name)),
  );
  return {
    protect: [...loops.protect, ...chats],
    protectSessionPaths: [...new Set([...loops.protectSessionPaths, ...sessions, ...chats.map(sessionProjectDir)])],
  };
};
