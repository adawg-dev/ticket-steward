import { runBrainDetached } from "../brain/spawn.js";
import { INTERRUPTED_ERROR, type BrainInput, type BrainRun, type McpServerSpec } from "../brain/types.js";
import type { BrainConfig } from "../config/schema.js";
import type { Redactor } from "../core/redact.js";
import { errorMessage, MINUTE_MS, SETUP_TAIL_BYTES } from "../core/workspace.js";
import { gitOrThrow } from "../workspace/git.js";
import { runSetup } from "../workspace/setup.js";
import type { RunReport, RunSpec } from "./protocol.js";

/** In a spec's prompt: replaced with the commits people pushed between `personCommits.from` and `.to`. */
export const PERSON_COMMITS_MARKER = "{{steward:personCommits}}";

/** What a failed setup's report error starts with; the redacted tail follows. */
export const SETUP_FAILED_PREFIX = "setup failed:\n";

/** The worktree the executor built for the spec. */
export interface PreparedWorkspace {
  path: string;
  sha: string;
}

/** Everything the run needs that the spec does not carry, built by the executor where the run happens. */
export interface ExecuteEnv {
  workspace: PreparedWorkspace;
  brain: BrainConfig;
  /** The env of setup and of the brain. */
  brainEnv: Record<string, string>;
  mcpServers: Record<string, McpServerSpec>;
  denyPaths: string[];
  /** openai-agents only: the skills it inlines into the prompt. */
  inlineSkills?: string[];
  redactor: Redactor;
  signal?: AbortSignal;
  runBrain?: typeof runBrainDetached;
}

/** The redacted setup tail of a report with `setupFailed`. */
export const setupTailOf = (report: Pick<RunReport, "error">): string => {
  const error = report.error ?? "";
  return error.startsWith(SETUP_FAILED_PREFIX) ? error.slice(SETUP_FAILED_PREFIX.length) : error;
};

const withPersonCommits = async (spec: RunSpec, workspacePath: string): Promise<string> => {
  if (!spec.prompt.includes(PERSON_COMMITS_MARKER)) return spec.prompt;
  const commits = spec.personCommits === null ? "" : await gitOrThrow(["log", "--format=%h %an %s", `${spec.personCommits.from}..${spec.personCommits.to}`], workspacePath);
  return spec.prompt.replaceAll(PERSON_COMMITS_MARKER, commits);
};

const brainInputOf = (spec: RunSpec, env: ExecuteEnv, prompt: string): BrainInput => ({
  workspacePath: env.workspace.path,
  artifactsDir: spec.artifactsDir,
  transcriptPath: spec.transcriptPath,
  prompt,
  env: env.brainEnv,
  timeoutMs: spec.limits.timeoutMinutes * MINUTE_MS,
  maxTurns: spec.limits.maxTurns,
  model: env.brain.model,
  ...(env.brain.kind === "openai-agents" && env.brain.reasoningEffort !== undefined ? { reasoningEffort: env.brain.reasoningEffort } : {}),
  mcpServers: env.mcpServers,
  ...(env.inlineSkills === undefined ? {} : { inlineSkills: env.inlineSkills }),
  denyPaths: env.denyPaths,
  output: spec.output,
  ...(spec.resumeSessionId === null ? {} : { resumeSessionId: spec.resumeSessionId }),
});

/**
 * The execute half of a run, in the prepared workspace: setup, then the brain with the spec's prompt (person commits
 * filled in). Never touches the DB, the tracker or the code host, and never throws: every failure is in the report.
 */
export const executeRun = async (spec: RunSpec, env: ExecuteEnv): Promise<RunReport> => {
  const failed = (error: string, patch: Partial<RunReport> = {}): RunReport => ({
    runId: spec.runId, ok: false, error, interrupted: false, setupFailed: false, sessionId: null, output: null, usage: null, ...patch,
  });
  const interrupted = (): boolean => env.signal?.aborted === true;

  let prompt: string;
  try {
    const setup = await runSetup(spec.setup, env.workspace.path, env.brainEnv, {
      timeoutMs: spec.limits.setupTimeoutMinutes * MINUTE_MS,
      tailBytes: SETUP_TAIL_BYTES,
      ...(env.signal === undefined ? {} : { signal: env.signal }),
    });
    if (!setup.ok) return failed(`${SETUP_FAILED_PREFIX}${env.redactor.redact(setup.tail)}`, { setupFailed: true, interrupted: interrupted() });
    prompt = await withPersonCommits(spec, env.workspace.path);
  } catch (err) {
    return interrupted() ? failed(INTERRUPTED_ERROR, { interrupted: true }) : failed(env.redactor.redact(errorMessage(err)));
  }

  let run: BrainRun;
  try {
    run = await (env.runBrain ?? runBrainDetached)(env.brain, brainInputOf(spec, env, prompt), env.redactor, { ...(env.signal === undefined ? {} : { signal: env.signal }) });
  } catch (err) {
    return failed(errorMessage(err));
  }
  return {
    runId: spec.runId,
    ok: run.ok,
    error: run.ok ? null : (run.error ?? null),
    interrupted: !run.ok && run.error === INTERRUPTED_ERROR,
    setupFailed: false,
    sessionId: run.sessionId ?? null,
    output: run.output ?? null,
    usage: run.usage ?? null,
  };
};
