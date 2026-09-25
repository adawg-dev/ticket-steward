import { readFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { z } from "zod";
import type { BrainInput, McpServerSpec } from "../brain/types.js";
import { codehostMcpSpec } from "../codehost/server.js";
import { logger } from "../log.js";
import { DB_FILENAME } from "../store/db.js";
import type { AttemptPatch } from "../store/index.js";
import { copyOverlay } from "../workspace/overlay.js";
import { freePort, isPortFree } from "../workspace/retention.js";
import { runSetup } from "../workspace/setup.js";
import { copySkills } from "../workspace/skills.js";
import { createWorktree, type Worktree } from "../workspace/worktree.js";
import type { PipelineDeps } from "./deps.js";
import type { Redactor } from "./redact.js";
import type { JobOutcome, RunContext } from "./types.js";

export interface JobPaths {
  worktreeName: string;
  workRoot: string;
  artifactsDir: string;
  transcriptPath: string;
}

const SETUP_TAIL_BYTES = 16 * 1024;
const MINUTE_MS = 60_000;

const PlaywrightPackage = z.object({ bin: z.union([z.string(), z.record(z.string(), z.string())]) });

export const errorMessage = (err: unknown): string => (err instanceof Error ? err.message : String(err));

export const jobPaths = (ctx: RunContext, deps: PipelineDeps): JobPaths => {
  const jobDir = join(deps.config.dataDir, "jobs", String(ctx.jobId));
  return {
    worktreeName: ctx.dryRun ? `dry-${process.pid}` : `${ctx.jobId}-${ctx.attempt}`,
    workRoot: join(deps.config.dataDir, "work"),
    artifactsDir: join(jobDir, "artifacts"),
    transcriptPath: join(jobDir, `attempt-${ctx.attempt}.jsonl`),
  };
};

export const patchAttempt = (ctx: RunContext, deps: PipelineDeps, patch: AttemptPatch): void => {
  if (ctx.dryRun) return;
  const current = deps.stores.attempts.forJob(ctx.jobId).find((row) => row.number === ctx.attempt);
  if (current !== undefined) deps.stores.attempts.patch(current.id, patch);
};

const playwrightMcpSpec = (): McpServerSpec => {
  const packagePath = createRequire(import.meta.url).resolve("@playwright/mcp/package.json");
  const { bin } = PlaywrightPackage.parse(JSON.parse(readFileSync(packagePath, "utf8")));
  const relative = typeof bin === "string" ? bin : Object.values(bin)[0];
  if (relative === undefined) throw new Error("@playwright/mcp declares no bin");
  return {
    command: process.execPath,
    args: [join(dirname(packagePath), relative)],
    env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? homedir() },
  };
};

/** Masks secrets in the outcome's error or warning before it is stored or sent to the tracker. */
export const redactOutcome = (outcome: JobOutcome, redactor: Redactor): JobOutcome => {
  if (outcome.status === "succeeded") return outcome.warning === undefined ? outcome : { ...outcome, warning: redactor.redact(outcome.warning) };
  return { ...outcome, error: redactor.redact(outcome.error) };
};

/** Creates the worktree at `sha`, then lays down the artifacts dir, overlay and skills, and runs setup. */
export const prepareWorkspace = async (
  ctx: RunContext,
  deps: PipelineDeps,
  paths: JobPaths,
  env: Record<string, string>,
  sha: string,
  onWorktree: (worktree: Worktree) => void,
): Promise<Worktree> => {
  const { config, mirror } = deps;
  const worktree = await createWorktree(mirror, paths.workRoot, paths.worktreeName, sha);
  onWorktree(worktree);
  await mkdir(paths.artifactsDir, { recursive: true, mode: 0o700 });
  const portRewrite = config.workspace.portRewrite === undefined ? {} : { portRewrite: { from: config.workspace.portRewrite.from, to: config.workspace.port } };
  await copyOverlay(config.workspace.overlayDir, worktree.path, portRewrite);
  await copySkills(config.workspace.skillsDir, worktree.path);
  const setup = await runSetup(config.workspace.setup, worktree.path, env, {
    timeoutMs: config.workspace.setupTimeoutMinutes * MINUTE_MS,
    tailBytes: SETUP_TAIL_BYTES,
    ...(deps.signal === undefined ? {} : { signal: deps.signal }),
  });
  if (!setup.ok) {
    const tail = deps.redactor.redact(setup.tail);
    patchAttempt(ctx, deps, { setupTail: tail });
    throw new Error(`setup failed:\n${tail}`);
  }
  return worktree;
};

export const brainInput = (deps: PipelineDeps, paths: JobPaths, worktree: Worktree, prompt: string, env: Record<string, string>): BrainInput => {
  const { config, mirror } = deps;
  return {
    workspacePath: worktree.path,
    artifactsDir: paths.artifactsDir,
    transcriptPath: paths.transcriptPath,
    prompt,
    env,
    timeoutMs: config.brain.timeoutMinutes * MINUTE_MS,
    maxTurns: config.brain.maxTurns,
    model: config.brain.model,
    mcpServers: {
      codehost: codehostMcpSpec({ binPath: deps.binPath, configPath: deps.configPath, worktreePath: worktree.path, sha: worktree.sha }),
      playwright: playwrightMcpSpec(),
    },
    denyPaths: [mirror.path, join(config.dataDir, DB_FILENAME), config.workspace.overlayDir, dirname(deps.configPath)],
  };
};

export const cleanupWorkspace = async (deps: PipelineDeps, worktree: Worktree | null, outcome: JobOutcome): Promise<void> => {
  const { port, keepOnFailure } = deps.config.workspace;
  try {
    if (!(await isPortFree(port))) await freePort(port);
    if (worktree === null || (outcome.status !== "succeeded" && keepOnFailure)) return;
    await worktree.destroy();
  } catch (err) {
    logger.warn({ err: errorMessage(err) }, "workspace cleanup failed");
  }
};

export const crashed = (err: unknown): JobOutcome => ({ status: "failed", error: errorMessage(err), retryable: false });
