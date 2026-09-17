import { readFileSync } from "node:fs";
import { mkdir, readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { z } from "zod";
import { buildBrainEnv, INTERRUPTED_ERROR, runBrainDetached } from "../brain/index.js";
import type { Brain, BrainInput, BrainRun, McpServerSpec } from "../brain/types.js";
import { codehostMcpSpec } from "../codehost/server.js";
import type { CodeHost } from "../codehost/types.js";
import type { Secrets } from "../config/load.js";
import type { StewardConfig } from "../config/schema.js";
import { logger } from "../log.js";
import { DB_FILENAME } from "../store/db.js";
import type { Stores, AttemptPatch } from "../store/index.js";
import type { Tracker, TicketBundle } from "../tracker/types.js";
import { Mirror } from "../workspace/mirror.js";
import { copyOverlay } from "../workspace/overlay.js";
import { freePort, isPortFree } from "../workspace/retention.js";
import { runSetup } from "../workspace/setup.js";
import { copySkills } from "../workspace/skills.js";
import { createWorktree, type Worktree } from "../workspace/worktree.js";
import { resolveAttachments } from "./attachments.js";
import { renderTemplatesMarkdown, renderTicketMarkdown } from "./context.js";
import { renderPrompt } from "./prompt.js";
import type { Redactor } from "./redact.js";
import { buildComment, buildEnrichmentSection, replaceSection } from "./render.js";
import { validateResult, type BrainResult } from "./result.js";
import type { JobOutcome, RunContext } from "./types.js";

export interface PipelineDeps {
  config: StewardConfig;
  secrets: Secrets;
  configPath: string;
  binPath: string;
  tracker: Tracker;
  brain: Brain;
  codehost: CodeHost;
  mirror: Mirror;
  stores: Stores;
  redactor: Redactor;
  now: () => Date;
  runBrain?: typeof runBrainDetached;
  /** Aborted on shutdown: setup and the brain stop, and the outcome carries `INTERRUPTED_ERROR`. */
  signal?: AbortSignal;
}

interface Session {
  id: string | null;
  operatorInstructions: string;
}

interface JobPaths {
  worktreeName: string;
  workRoot: string;
  artifactsDir: string;
  transcriptPath: string;
}

interface Prepared {
  bundle: TicketBundle;
  worktree: Worktree;
  prompt: string;
}

const SETUP_TAIL_BYTES = 16 * 1024;
const MINUTE_MS = 60_000;

const PlaywrightPackage = z.object({ bin: z.union([z.string(), z.record(z.string(), z.string())]) });

const errorMessage = (err: unknown): string => (err instanceof Error ? err.message : String(err));

const firstLine = (text: string): string => text.split("\n")[0] ?? text;

/** Runs a best-effort tracker write whose failure must not change the job's outcome. */
const attempt = async (what: string, fn: () => Promise<void>): Promise<void> => {
  try {
    await fn();
  } catch (err) {
    logger.warn({ what, err: errorMessage(err) }, "non-fatal pipeline step failed");
  }
};

const resolveSession = (ctx: RunContext, deps: PipelineDeps): Session => {
  const job = ctx.dryRun ? null : deps.stores.jobs.get(ctx.jobId);
  const trigger = ctx.trigger.kind === "agent.session" ? ctx.trigger : null;
  return {
    id: trigger?.sessionId ?? job?.sessionId ?? null,
    operatorInstructions: trigger?.promptBody ?? job?.promptBody ?? "",
  };
};

const jobPaths = (ctx: RunContext, deps: PipelineDeps): JobPaths => {
  const jobDir = join(deps.config.dataDir, "jobs", String(ctx.jobId));
  return {
    worktreeName: ctx.dryRun ? `dry-${process.pid}` : `${ctx.jobId}-${ctx.attempt}`,
    workRoot: join(deps.config.dataDir, "work"),
    artifactsDir: join(jobDir, "artifacts"),
    transcriptPath: join(jobDir, `attempt-${ctx.attempt}.jsonl`),
  };
};

const patchAttempt = (ctx: RunContext, deps: PipelineDeps, patch: AttemptPatch): void => {
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

const redactResult = (result: BrainResult, redactor: Redactor): BrainResult => ({
  ...result,
  summary: redactor.redact(result.summary),
  enrichment: redactor.redact(result.enrichment),
  attachments: result.attachments.map((item) => ({ ...item, caption: redactor.redact(item.caption) })),
});

const prepare = async (ctx: RunContext, deps: PipelineDeps, session: Session, paths: JobPaths, env: Record<string, string>, onWorktree: (worktree: Worktree) => void): Promise<Prepared> => {
  const { config, tracker, mirror } = deps;
  const bundle = await tracker.fetchTicket(ctx.issueId);
  await mirror.fetch();
  const sha = await mirror.resolveSha(config.workspace.baseBranch);
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
  const prompt = renderPrompt(await readFile(config.prompt, "utf8"), {
    ticket: renderTicketMarkdown(bundle),
    templates: renderTemplatesMarkdown(bundle),
    workspacePath: worktree.path,
    baseBranch: config.workspace.baseBranch,
    sha,
    artifactsDir: paths.artifactsDir,
    teamKey: ctx.teamKey,
    teamName: bundle.team.name,
    stewardPort: config.workspace.port,
    operatorInstructions: session.operatorInstructions,
  });
  return { bundle, worktree, prompt };
};

const brainInput = (deps: PipelineDeps, paths: JobPaths, worktree: Worktree, prompt: string, env: Record<string, string>): BrainInput => {
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

const uploadAttachments = async (deps: PipelineDeps, artifactsDir: string, result: BrainResult): Promise<{ uploaded: Array<{ url: string; caption: string }>; notes: string[] }> => {
  const { accepted, notes } = await resolveAttachments(artifactsDir, result.attachments);
  const uploaded: Array<{ url: string; caption: string }> = [];
  for (const item of accepted) {
    try {
      const { url } = await deps.tracker.uploadFile(item.path, item.contentType);
      uploaded.push({ url, caption: item.caption });
    } catch (err) {
      logger.warn({ file: item.path, err: errorMessage(err) }, "attachment upload failed");
      notes.push(`Attachment \`${basename(item.path)}\` dropped: upload failed.`);
    }
  }
  return { uploaded, notes: notes.map((note) => deps.redactor.redact(note)) };
};

const publish = async (ctx: RunContext, deps: PipelineDeps, session: Session, stored: BrainResult, sha: string, artifactsDir: string): Promise<JobOutcome> => {
  const { tracker, config, codehost } = deps;
  const result = redactResult(stored, deps.redactor);
  try {
    const { uploaded, notes } = await uploadAttachments(deps, artifactsDir, result);
    const section = buildEnrichmentSection(result, uploaded, notes, {
      now: deps.now(),
      sha,
      branch: config.workspace.baseBranch,
      jobId: ctx.jobId,
      permalink: (path, line) => codehost.permalink(path, sha, line),
    });
    const current = await tracker.readDescription(ctx.issueId);
    patchAttempt(ctx, deps, { preWriteDescription: current });
    await tracker.writeDescription(ctx.issueId, replaceSection(current, section));
  } catch (err) {
    return { status: "publish_failed", error: errorMessage(err) };
  }
  const comment = buildComment(result, ctx.jobId);
  try {
    if (session.id === null) await tracker.postComment(ctx.issueId, comment);
    else await tracker.agentSession.response(session.id, comment);
  } catch (err) {
    return { status: "succeeded", warning: errorMessage(err) };
  }
  return { status: "succeeded" };
};

const cleanup = async (deps: PipelineDeps, worktree: Worktree | null, outcome: JobOutcome): Promise<void> => {
  const { port, keepOnFailure } = deps.config.workspace;
  try {
    if (!(await isPortFree(port))) await freePort(port);
    if (worktree === null || (outcome.status !== "succeeded" && keepOnFailure)) return;
    await worktree.destroy();
  } catch (err) {
    logger.warn({ err: errorMessage(err) }, "workspace cleanup failed");
  }
};

const execute = async (ctx: RunContext, deps: PipelineDeps, session: Session, onWorktree: (worktree: Worktree) => void): Promise<JobOutcome> => {
  const { config, secrets, tracker } = deps;
  const paths = jobPaths(ctx, deps);
  const env = buildBrainEnv(secrets, config.brain, config.workspace.port);
  let prepared: Prepared;
  try {
    prepared = await prepare(ctx, deps, session, paths, env, onWorktree);
  } catch (err) {
    return { status: "failed", error: deps.signal?.aborted === true ? INTERRUPTED_ERROR : errorMessage(err), retryable: true };
  }
  const { worktree, prompt } = prepared;
  if (session.id !== null) {
    const sessionId = session.id;
    await attempt("thought", () =>
      tracker.agentSession.thought(
        sessionId,
        `Investigating \`${config.workspace.baseBranch}@${worktree.sha.slice(0, 7)}\`: reading the ticket and locating the relevant code.`,
      ),
    );
  }
  let run: BrainRun;
  try {
    run = await (deps.runBrain ?? runBrainDetached)(config.brain, brainInput(deps, paths, worktree, prompt, env), deps.redactor, {
      ...(deps.signal === undefined ? {} : { signal: deps.signal }),
    });
  } catch (err) {
    return { status: "failed", error: errorMessage(err), retryable: false };
  }
  patchAttempt(ctx, deps, { transcriptPath: paths.transcriptPath, ...(run.usage === undefined ? {} : { usage: run.usage }) });
  if (!run.ok) return { status: "failed", error: run.error ?? "brain run failed", retryable: run.error === INTERRUPTED_ERROR };
  const validated = validateResult(run.output);
  if (!validated.ok) return { status: "failed", error: validated.error, retryable: false };
  if (!ctx.dryRun) deps.stores.jobs.saveResult(ctx.jobId, validated.result, worktree.sha);
  return publish(ctx, deps, session, validated.result, worktree.sha, paths.artifactsDir);
};

const reportTerminalFailure = async (deps: PipelineDeps, session: Session, outcome: JobOutcome): Promise<void> => {
  if (session.id === null || outcome.status !== "failed" || outcome.retryable) return;
  const sessionId = session.id;
  await attempt("error", () => deps.tracker.agentSession.error(sessionId, `Enrichment failed: ${firstLine(outcome.error)}`));
};

const crashed = (err: unknown): JobOutcome => ({ status: "failed", error: errorMessage(err), retryable: false });

export const runJob = async (ctx: RunContext, deps: PipelineDeps): Promise<JobOutcome> => {
  const session = resolveSession(ctx, deps);
  const workspace: { worktree: Worktree | null } = { worktree: null };
  const outcome = redactOutcome(
    await execute(ctx, deps, session, (created) => {
      workspace.worktree = created;
    }).catch(crashed),
    deps.redactor,
  );
  await cleanup(deps, workspace.worktree, outcome);
  await reportTerminalFailure(deps, session, outcome);
  return outcome;
};

export const publishOnly = async (ctx: RunContext, deps: PipelineDeps): Promise<JobOutcome> => {
  const job = deps.stores.jobs.get(ctx.jobId);
  if (job === null || job.result === null || job.resultSha === null) {
    return { status: "failed", error: "no stored result to publish", retryable: false };
  }
  const session = resolveSession(ctx, deps);
  const { artifactsDir } = jobPaths(ctx, deps);
  await mkdir(artifactsDir, { recursive: true, mode: 0o700 });
  return publish(ctx, deps, session, job.result, job.resultSha, artifactsDir);
};
