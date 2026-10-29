import { mkdir } from "node:fs/promises";
import { basename, dirname } from "node:path";
import { buildBrainEnv } from "../brain/env.js";
import { sessionWorktree } from "../chat/session.js";
import type { PipelineDeps } from "../core/deps.js";
import { brainInput, bringSlotUp, cleanupWorkspace, errorMessage, furnishWorktree, jobPort, sessionsDir } from "../core/workspace.js";
import { unpushedWork } from "../implement/git.js";
import { guardSecrets, settingsOf, stewardCopies } from "../implement/pipeline.js";
import { logger } from "../log.js";
import { settleUnfinished } from "../push/ledger.js";
import { remoteHeadOf } from "../push/service.js";
import { createWorktree, type Worktree } from "../workspace/worktree.js";
import { drainChannel } from "./channel.js";
import { executeRun } from "./execute.js";
import type { RunExecutor } from "./executor.js";
import type { RunSpec, WorkReport } from "./protocol.js";

/** The run's worktree: built for this run, or the session's, which a chat reuses and keeps (sessions are keyed by path). */
interface LocalWorkspace {
  worktree: Worktree;
  /** `workspace.setup` already ran in it for an earlier run: a reused session worktree. */
  setUp: boolean;
}

/**
 * Brings the slot up (with `slots`), then the worktree at the spec's commit with the steward's files laid into it: a new
 * one, or for a chat the session's own (reused as it stands, or recreated at the same path when it was swept).
 */
const prepareLocalWorkspace = async (deps: PipelineDeps, spec: RunSpec, env: Record<string, string>, onWorktree: (worktree: Worktree) => void): Promise<LocalWorkspace> => {
  const port = jobPort(deps);
  const slot = await bringSlotUp(deps, port);
  await mkdir(spec.artifactsDir, { recursive: true, mode: 0o700 });
  if (spec.kind === "chat") {
    const session = { worktreeName: basename(spec.worktreePath), headSha: spec.checkout.sha };
    const { worktree, created } = await sessionWorktree(deps, session, { env, port, slot });
    return { worktree, setUp: !created };
  }
  const worktree = await createWorktree(deps.mirror, dirname(spec.worktreePath), basename(spec.worktreePath), spec.checkout.sha);
  onWorktree(worktree);
  // Setup runs in executeRun, after the overlay and the Orbit index.
  await furnishWorktree(deps, worktree.path, env, { port, slot, setup: false });
  return { worktree, setUp: false };
};

/**
 * The last commit the push tool pushed for the job. A push it recorded but stopped before marking counts when the remote
 * branch is at its commit; a remote that cannot be read leaves that to the steward's own check after the run.
 */
const pushedShaOf = async (deps: PipelineDeps, spec: RunSpec): Promise<string | null> => {
  if (spec.push === null) return null;
  const configured = settingsOf(deps);
  if (configured !== null) {
    await settleUnfinished(deps, spec.push, remoteHeadOf(deps, spec.push, configured.remote)).catch((err: unknown) => {
      logger.warn({ jobId: spec.jobId, err: errorMessage(err) }, "could not settle the run's last push");
    });
  }
  // The job the pushes are recorded on: a chat without a loop records them on the session's implement job.
  return deps.stores.pushes.latestPushed(spec.push.jobId)?.sha ?? null;
};

/** What the agent left in the worktree after the last push (or the branch head it started from); never the files the steward copied in. */
const workOf = async (deps: PipelineDeps, spec: RunSpec, worktree: Worktree): Promise<WorkReport> => {
  const pushedSha = await pushedShaOf(deps, spec);
  try {
    const { files: overlayFiles } = await guardSecrets(deps.config.workspace.overlayDir, deps.secrets);
    const stewardFiles = await stewardCopies(deps.config.workspace.skillsDir, overlayFiles);
    // Without a push this run, the branch head it started from: a reused session worktree may be ahead of it with an
    // earlier chat's unpushed commits (behind it, the range is empty). Answer-only, the commit the run started at.
    const since = pushedSha ?? (spec.push !== null ? spec.checkout.sha : worktree.sha);
    const work = await unpushedWork({ worktreePath: worktree.path, pushedSha: since, stewardFiles });
    return { runId: spec.runId, unpushed: work.summary, pushedSha };
  } catch (err) {
    // Read as unpushed work, so the run hands back to a person instead of passing over what could not be checked.
    return { runId: spec.runId, unpushed: `the worktree could not be read: ${errorMessage(err)}`, pushedSha };
  }
};

/**
 * Runs the execute half in-process on the steward's host: the mirror's worktree, the job's slot, the overlay and the
 * Orbit index, the MCP servers spawned over stdio, then `executeRun`. With `deps.channels`, the run's channel is open
 * while it executes: the brain's redacted lines go through it to `hooks.onLine`, and its commands to the detached
 * runner. Without, the lines go to `hooks.onLine` directly. The worktree is removed afterwards, unless the run
 * failed and `workspace.keepOnFailure` keeps it or it is a chat's session worktree. Rejects when the workspace could not be built.
 */
export const localExecutor = (deps: PipelineDeps): RunExecutor => ({
  execute: async (spec, signal = deps.signal, hooks = {}) => {
    const runDeps: PipelineDeps = signal === undefined ? deps : { ...deps, signal };
    const { channels } = deps;
    const onLine = hooks.onLine ?? (() => undefined);
    channels?.open(spec.runId, onLine, spec.issueId, spec.jobId);
    const steering = channels === undefined ? null : drainChannel(channels, spec.runId);
    const env = buildBrainEnv(deps.secrets, deps.config.brain, jobPort(deps), sessionsDir(deps.config), deps.config.implement?.commitAuthor);
    const workspace: { worktree: Worktree | null } = { worktree: null };
    let ok = false;
    try {
      const { worktree, setUp } = await prepareLocalWorkspace(runDeps, spec, env, (created) => {
        workspace.worktree = created;
      });
      const input = brainInput(runDeps, spec, worktree, spec.prompt, env, spec.output, spec.push === null ? {} : { push: spec.push });
      const report = await executeRun(setUp ? { ...spec, setup: [] } : spec, {
        workspace: worktree,
        brain: deps.config.brain,
        brainEnv: input.env,
        mcpServers: input.mcpServers,
        denyPaths: input.denyPaths,
        ...(input.inlineSkills === undefined ? {} : { inlineSkills: input.inlineSkills }),
        redactor: deps.redactor,
        onLine: channels === undefined ? onLine : (line) => channels.line(spec.runId, line),
        ...(steering === null ? {} : { control: steering.control }),
        ...(signal === undefined ? {} : { signal }),
        ...(deps.runBrain === undefined ? {} : { runBrain: deps.runBrain }),
      });
      ok = report.ok;
      // The brain has ended: a steer from now on would reach nothing, so callers fall back instead.
      steering?.end();
      channels?.endSteering(spec.runId);
      return { report, work: await workOf(runDeps, spec, worktree) };
    } finally {
      steering?.end();
      channels?.close(spec.runId);
      await cleanupWorkspace(runDeps, workspace.worktree, ok ? { status: "succeeded" } : { status: "failed", error: "the run failed", retryable: false });
    }
  },
});
