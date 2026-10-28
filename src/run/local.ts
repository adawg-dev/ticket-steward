import { mkdir } from "node:fs/promises";
import { basename, dirname } from "node:path";
import { buildBrainEnv } from "../brain/env.js";
import type { PipelineDeps } from "../core/deps.js";
import { brainInput, bringSlotUp, cleanupWorkspace, errorMessage, furnishWorktree, jobPort, sessionsDir } from "../core/workspace.js";
import { unpushedWork } from "../implement/git.js";
import { guardSecrets, settingsOf, stewardCopies } from "../implement/pipeline.js";
import { logger } from "../log.js";
import { settleUnfinished } from "../push/ledger.js";
import { remoteHeadOf } from "../push/service.js";
import { createWorktree, type Worktree } from "../workspace/worktree.js";
import { executeRun } from "./execute.js";
import type { RunExecutor } from "./executor.js";
import type { RunSpec, WorkReport } from "./protocol.js";

/** Brings the slot up (with `slots`), creates the worktree at the spec's commit and lays the steward's files into it. */
const prepareLocalWorkspace = async (deps: PipelineDeps, spec: RunSpec, env: Record<string, string>, onWorktree: (worktree: Worktree) => void): Promise<Worktree> => {
  const port = jobPort(deps);
  const slot = await bringSlotUp(deps, port);
  const worktree = await createWorktree(deps.mirror, dirname(spec.worktreePath), basename(spec.worktreePath), spec.checkout.sha);
  onWorktree(worktree);
  await mkdir(spec.artifactsDir, { recursive: true, mode: 0o700 });
  // Setup runs in executeRun, after the overlay and the Orbit index.
  await furnishWorktree(deps, worktree.path, env, { port, slot, setup: false });
  return worktree;
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
  return deps.stores.pushes.latestPushed(spec.jobId)?.sha ?? null;
};

/** What the agent left in the worktree after the last push (or the checkout); never the files the steward copied in. */
const workOf = async (deps: PipelineDeps, spec: RunSpec, worktree: Worktree): Promise<WorkReport> => {
  const pushedSha = await pushedShaOf(deps, spec);
  try {
    const { files: overlayFiles } = await guardSecrets(deps.config.workspace.overlayDir, deps.secrets);
    const stewardFiles = await stewardCopies(deps.config.workspace.skillsDir, overlayFiles);
    const work = await unpushedWork({ worktreePath: worktree.path, pushedSha: pushedSha ?? spec.checkout.sha, stewardFiles });
    return { runId: spec.runId, unpushed: work.summary, pushedSha };
  } catch (err) {
    // Read as unpushed work, so the run hands back to a person instead of passing over what could not be checked.
    return { runId: spec.runId, unpushed: `the worktree could not be read: ${errorMessage(err)}`, pushedSha };
  }
};

/**
 * Runs the execute half in-process on the steward's host: the mirror's worktree, the job's slot, the overlay and the
 * Orbit index, the MCP servers spawned over stdio, then `executeRun`. The worktree is removed afterwards, unless the run
 * failed and `workspace.keepOnFailure` keeps it. Rejects when the workspace could not be built.
 */
export const localExecutor = (deps: PipelineDeps): RunExecutor => ({
  execute: async (spec, signal = deps.signal) => {
    const runDeps: PipelineDeps = signal === undefined ? deps : { ...deps, signal };
    const env = buildBrainEnv(deps.secrets, deps.config.brain, jobPort(deps), sessionsDir(deps.config), deps.config.implement?.commitAuthor);
    const workspace: { worktree: Worktree | null } = { worktree: null };
    let ok = false;
    try {
      const worktree = await prepareLocalWorkspace(runDeps, spec, env, (created) => {
        workspace.worktree = created;
      });
      const input = brainInput(runDeps, spec, worktree, spec.prompt, env, spec.output, spec.push === null ? {} : { push: spec.push });
      const report = await executeRun(spec, {
        workspace: worktree,
        brain: deps.config.brain,
        brainEnv: input.env,
        mcpServers: input.mcpServers,
        denyPaths: input.denyPaths,
        ...(input.inlineSkills === undefined ? {} : { inlineSkills: input.inlineSkills }),
        redactor: deps.redactor,
        ...(signal === undefined ? {} : { signal }),
        ...(deps.runBrain === undefined ? {} : { runBrain: deps.runBrain }),
      });
      ok = report.ok;
      return { report, work: await workOf(runDeps, spec, worktree) };
    } finally {
      await cleanupWorkspace(runDeps, workspace.worktree, ok ? { status: "succeeded" } : { status: "failed", error: "the run failed", retryable: false });
    }
  },
});
