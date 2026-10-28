import { existsSync, readdirSync, readFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { z } from "zod";
import { INTERRUPTED_ERROR, type BrainInput, type BrainOutput, type McpServerSpec } from "../brain/types.js";
import { playwrightEnv } from "../brain/env.js";
import { codehostMcpSpec } from "../codehost/server.js";
import { pushMcpSpec, type PushTarget } from "../push/target.js";
import { appPortOf } from "../config/schema.js";
import { logger } from "../log.js";
import { DB_FILENAME } from "../store/db.js";
import type { AttemptPatch } from "../store/index.js";
import { copyOverlay, OverrideKeysError } from "../workspace/overlay.js";
import { freePort, isPortFree } from "../workspace/retention.js";
import { runSetup } from "../workspace/setup.js";
import { copySkills } from "../workspace/skills.js";
import { renderSlotEnv, SlotError, type Slot } from "../workspace/slots.js";
import { createWorktree, type Worktree } from "../workspace/worktree.js";
import type { PipelineDeps } from "./deps.js";
import type { Redactor } from "./redact.js";
import type { JobOutcome, RunContext } from "./types.js";

export interface JobPaths {
  worktreeName: string;
  jobDir: string;
  workRoot: string;
  artifactsDir: string;
  transcriptPath: string;
}

const SETUP_TAIL_BYTES = 16 * 1024;
const MINUTE_MS = 60_000;

const PlaywrightPackage = z.object({ bin: z.union([z.string(), z.record(z.string(), z.string())]) });

/** Where claude-code keeps its sessions (`CLAUDE_CONFIG_DIR`); denied to the agent because the files are unredacted. */
export const sessionsDir = (config: PipelineDeps["config"]): string => join(config.dataDir, "sessions");

export const errorMessage = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/** A ticket's fix-loop worktree name: one path per ticket, so a resumed brain session finds its project by cwd. */
export const stableWorktreeName = (identifier: string): string => `ticket-${identifier}`;

/** The steward-owned directory for one job's bundles, transcripts and artifacts. */
export const jobDirOf = (dataDir: string, jobId: number): string => join(dataDir, "jobs", String(jobId));

/** The job's on-disk paths; `worktreeName` overrides the per-attempt worktree (a dry run always gets its own). */
export const jobPaths = (ctx: RunContext, deps: PipelineDeps, opts: { worktreeName?: string } = {}): JobPaths => {
  const jobDir = jobDirOf(deps.config.dataDir, ctx.jobId);
  return {
    jobDir,
    worktreeName: ctx.dryRun ? `dry-${process.pid}` : (opts.worktreeName ?? `${ctx.jobId}-${ctx.attempt}`),
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
    // Console output at info level ran to 100k+ characters per call; warnings and errors are what bugs show up as.
    args: [join(dirname(packagePath), relative), "--console-level", "warning"],
    env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? homedir(), ...playwrightEnv() },
  };
};

/** Masks secrets in the outcome's error or warning before it is stored or sent to the tracker. */
export const redactOutcome = (outcome: JobOutcome, redactor: Redactor): JobOutcome => {
  if (outcome.status === "succeeded") return outcome.warning === undefined ? outcome : { ...outcome, warning: redactor.redact(outcome.warning) };
  if (outcome.status === "deferred") return outcome;
  return { ...outcome, error: redactor.redact(outcome.error) };
};

/** The job's app port: its slot's with `slots` configured, otherwise `workspace.port`. */
export const jobPort = (deps: Pick<PipelineDeps, "config" | "slot">): number => appPortOf(deps.config, deps.slot?.n ?? 1);

/** With `slots`: frees the slot's app port and brings its containers up fresh. Null without `slots`. */
export const startSlot = async (ctx: RunContext, deps: PipelineDeps, appPort: number): Promise<Slot | null> => {
  if (deps.config.slots === undefined) return null;
  if (deps.slot === undefined) throw new Error("slots is configured but this run has no slot");
  const { n, client } = deps.slot;
  if (!(await isPortFree(appPort))) await freePort(appPort);
  try {
    return { n, appPort, ports: await client.start(n, deps.signal) };
  } catch (err) {
    if (!(err instanceof SlotError)) throw err;
    const tail = deps.redactor.redact(err.tail);
    patchAttempt(ctx, deps, { setupTail: tail });
    throw new Error(`setup failed: slot ${n}: ${tail}`);
  }
};

/**
 * Lays the steward's files into a worktree for a run on `port` (and `slot`, with `slots`): the overlay (port-rewritten and
 * slot-overridden) and skills, then, with `setup`, `workspace.setup`. Returns the redacted setup tail when setup fails.
 */
export const furnishWorktree = async (
  deps: Pick<PipelineDeps, "config" | "redactor" | "signal">,
  worktreePath: string,
  env: Record<string, string>,
  placement: { port: number; slot: Slot | null; setup: boolean },
): Promise<{ setupTail: string } | null> => {
  const { config } = deps;
  const { port, slot } = placement;
  await mkdir(sessionsDir(config), { recursive: true, mode: 0o700 });
  const portRewrite = config.workspace.portRewrite === undefined ? {} : { portRewrite: { from: config.workspace.portRewrite.from, to: port } };
  const overrides = slot === null || config.slots === undefined ? {} : { overrides: renderSlotEnv(config.slots.env, slot) };
  await copyOverlay(config.workspace.overlayDir, worktreePath, { ...portRewrite, ...overrides });
  await copySkills(config.workspace.skillsDir, worktreePath);
  if (!placement.setup) return null;
  const setup = await runSetup(config.workspace.setup, worktreePath, env, {
    timeoutMs: config.workspace.setupTimeoutMinutes * MINUTE_MS,
    tailBytes: SETUP_TAIL_BYTES,
    ...(deps.signal === undefined ? {} : { signal: deps.signal }),
  });
  return setup.ok ? null : { setupTail: deps.redactor.redact(setup.tail) };
};

/** Brings the job's slot up (with `slots`), creates the worktree at `sha`, then lays down the artifacts dir, overlay and skills, and runs setup. */
export const prepareWorkspace = async (
  ctx: RunContext,
  deps: PipelineDeps,
  paths: JobPaths,
  env: Record<string, string>,
  sha: string,
  onWorktree: (worktree: Worktree) => void,
): Promise<Worktree> => {
  const { mirror } = deps;
  const port = jobPort(deps);
  const slot = await startSlot(ctx, deps, port);
  const worktree = await createWorktree(mirror, paths.workRoot, paths.worktreeName, sha);
  onWorktree(worktree);
  await mkdir(paths.artifactsDir, { recursive: true, mode: 0o700 });
  const failed = await furnishWorktree(deps, worktree.path, env, { port, slot, setup: true });
  if (failed !== null) {
    patchAttempt(ctx, deps, { setupTail: failed.setupTail });
    throw new Error(`setup failed:\n${failed.setupTail}`);
  }
  return worktree;
};

/** The steward's own skills: only these are inlined for openai-agents, not the repo's whole .claude/skills. */
const stewardSkillNames = (skillsDir: string | undefined): string[] =>
  skillsDir === undefined || !existsSync(skillsDir)
    ? []
    : readdirSync(skillsDir, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name)
        .sort();

/** What the agent may neither read nor write: the mirror, the DB, the overlay, the config dir and the session store. */
export const brainDenyPaths = (config: PipelineDeps["config"], configPath: string, mirrorDir: string): string[] => [
  mirrorDir,
  join(config.dataDir, DB_FILENAME),
  config.workspace.overlayDir,
  dirname(configPath),
  sessionsDir(config),
];

export const brainInput = (
  deps: PipelineDeps,
  paths: JobPaths,
  worktree: Worktree,
  prompt: string,
  env: Record<string, string>,
  output: BrainOutput,
  opts: { limits?: { timeoutMinutes: number; maxTurns: number }; resumeSessionId?: string; push?: PushTarget } = {},
): BrainInput => {
  const { config, mirror } = deps;
  const { limits } = opts;
  return {
    workspacePath: worktree.path,
    artifactsDir: paths.artifactsDir,
    transcriptPath: paths.transcriptPath,
    prompt,
    env,
    timeoutMs: (limits?.timeoutMinutes ?? config.brain.timeoutMinutes) * MINUTE_MS,
    maxTurns: limits?.maxTurns ?? config.brain.maxTurns,
    model: config.brain.model,
    ...(config.brain.kind === "openai-agents" && config.brain.reasoningEffort !== undefined ? { reasoningEffort: config.brain.reasoningEffort } : {}),
    mcpServers: {
      codehost: codehostMcpSpec({ binPath: deps.binPath, configPath: deps.configPath, worktreePath: worktree.path, sha: worktree.sha }),
      playwright: playwrightMcpSpec(),
      // Only a run that may push gets the push tool; its target is fixed here, never chosen by the agent.
      ...(opts.push === undefined ? {} : { push: pushMcpSpec({ binPath: deps.binPath, configPath: deps.configPath, target: opts.push }) }),
    },
    inlineSkills: stewardSkillNames(config.workspace.skillsDir),
    denyPaths: brainDenyPaths(config, deps.configPath, mirror.path),
    output,
    ...(opts.resumeSessionId === undefined ? {} : { resumeSessionId: opts.resumeSessionId }),
  };
};

/** Frees the app port, removes the worktree unless a failure keeps it, and brings the job's slot down. */
export const cleanupWorkspace = async (deps: PipelineDeps, worktree: Worktree | null, outcome: JobOutcome): Promise<void> => {
  const port = jobPort(deps);
  const keep = outcome.status !== "succeeded" && deps.config.workspace.keepOnFailure;
  try {
    if (!(await isPortFree(port))) await freePort(port);
    if (worktree !== null && !keep) await worktree.destroy();
  } catch (err) {
    logger.warn({ err: errorMessage(err) }, "workspace cleanup failed");
  }
  if (deps.slot !== undefined) await deps.slot.client.release(deps.slot.n);
};

/** A failed workspace preparation: interrupted on shutdown, terminal for a slot override key the overlay lacks, otherwise retryable. */
export const prepareFailed = (deps: PipelineDeps, err: unknown): JobOutcome =>
  deps.signal?.aborted === true
    ? { status: "failed", error: INTERRUPTED_ERROR, retryable: true }
    : { status: "failed", error: errorMessage(err), retryable: !(err instanceof OverrideKeysError) };

export const crashed = (err: unknown): JobOutcome => ({ status: "failed", error: errorMessage(err), retryable: false });
