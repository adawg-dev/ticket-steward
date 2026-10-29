import { existsSync } from "node:fs";
import { readdir } from "node:fs/promises";
import type { Command } from "commander";
import { z } from "zod";
import { retentionProtection } from "../chat/session.js";
import type { JobOutcome } from "../core/types.js";
import { sessionsDir } from "../core/workspace.js";
import { loopOfJob, retryMode } from "../server/admin.js";
import { openStores, type JobStatus } from "../store/index.js";
import { sweep } from "../workspace/retention.js";
import { AdminError, connectAdmin, type AdminClient, type JobSummary, type LoopView } from "./client.js";
import { errorMessage, fail, loadFromProgram, println, type CliContext } from "./context.js";
import { reportOutcome, runInline, tailJob, terminalOutcome, TAIL_POLL_MS, withRunLock } from "./inline.js";
import { artifactsDir, jobsDir, workRoot } from "./paths.js";
import { answers, localHealthUrl, sleep } from "./probe.js";
import { buildRuntime, CLI_SECRET_NAMES } from "./runtime.js";

const DEFAULT_LIMIT = 20;
const HEALTH_TIMEOUT_MS = 2_000;
const DELIVERY_RETENTION_DAYS = 7;
const STATUSES: JobStatus[] = ["queued", "running", "succeeded", "failed", "publish_failed", "skipped"];

const isStatus = (value: string): value is JobStatus => STATUSES.some((status) => status === value);

const parseStatus = (value: string): JobStatus => {
  if (!isStatus(value)) throw new Error(`unknown status ${value}; expected one of ${STATUSES.join(", ")}`);
  return value;
};

const parseId = (value: string): number => {
  const id = Number.parseInt(value, 10);
  if (!Number.isInteger(id) || id <= 0) throw new Error(`invalid job id ${value}`);
  return id;
};

export const jobLine = (job: JobSummary): string =>
  [job.id, job.status, job.identifier, job.kind, `attempts=${job.attempts}`, job.createdAt].join("\t");

const pretty = (value: unknown): string => JSON.stringify(value, null, 2);

/** One line per review round: `round 1: 3/5 ...`; an unscored round shows `?/5`. */
export const roundLines = (loop: Pick<LoopView, "history">): string[] =>
  loop.history.map(
    (round) =>
      `round ${round.round}: ${round.score ?? "?"}/5 head ${round.headSha.slice(0, 7)} pipeline ${round.pipeline ?? "-"} fixed ${round.fixed} declined ${round.declined} ${round.outcome}`,
  );

const loopHeader = (loop: LoopView): string => `loop ${loop.id}: ${loop.state}, round ${loop.round}, ${loop.mrUrl ?? "no MR yet"}`;

const listArtifacts = async (dir: string): Promise<string[]> => (existsSync(dir) ? (await readdir(dir)).sort() : []);

const HealthWorker = z.object({ worker: z.object({ running: z.array(z.object({ slot: z.number(), jobId: z.number() })) }) });

/** The running slots as `steward serve` reports them; null when serve does not answer. */
const runningLine = async (ctx: CliContext, port: number): Promise<string | null> => {
  try {
    const response = await ctx.fetchImpl(localHealthUrl(port), { signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS) });
    const parsed = HealthWorker.safeParse(await response.json());
    if (!parsed.success) return null;
    const { running } = parsed.data.worker;
    return `# running: ${running.length === 0 ? "none" : running.map(({ slot, jobId }) => `slot ${slot} job ${jobId}`).join(", ")}`;
  } catch {
    return null;
  }
};

/** The admin API when `serve` answers it (Kubernetes); null sends the command to the DB (the Compose host). */
const admin = (ctx: CliContext, config: Parameters<typeof connectAdmin>[1]): Promise<AdminClient | null> =>
  connectAdmin(ctx, config).catch((err: unknown) => fail(ctx, errorMessage(err)));

/** Prints each non-terminal status change of a job, read through the admin API, then returns its terminal outcome. */
const tailOverApi = async (client: AdminClient, jobId: number, ctx: CliContext): Promise<JobOutcome> => {
  let last: string | null = null;
  for (;;) {
    const detail = await client.job(jobId);
    if (detail === null) return fail(ctx, `job ${jobId} disappeared`);
    const { status, error } = detail.job;
    const outcome = terminalOutcome(status, typeof error === "string" ? error : null);
    if (outcome !== null) return outcome;
    if (status !== last) {
      last = status;
      println(ctx, `job ${jobId} ${status}`);
    }
    await sleep(TAIL_POLL_MS);
  }
};

const printDetail = async (ctx: CliContext, dataDir: string, id: number, detail: { job: unknown; attempts: Array<{ transcriptPath: string | null }>; loop: LoopView | null }): Promise<void> => {
  println(ctx, `# job\n${pretty(detail.job)}`);
  println(ctx, `# attempts\n${pretty(detail.attempts)}`);
  println(ctx, `# transcripts\n${detail.attempts.map((attempt) => attempt.transcriptPath ?? "(none)").join("\n")}`);
  println(ctx, `# artifacts (${artifactsDir(dataDir, id)})\n${(await listArtifacts(artifactsDir(dataDir, id))).join("\n")}`);
  if (detail.loop !== null) println(ctx, [`# loop`, loopHeader(detail.loop), ...roundLines(detail.loop)].join("\n"));
};

export const registerJobs = (program: Command, ctx: CliContext): void => {
  const jobs = program
    .command("jobs")
    .description("list jobs")
    .option("--status <status>", `filter by status (${STATUSES.join(", ")})`, parseStatus)
    .option("--limit <n>", "maximum rows", parseId, DEFAULT_LIMIT)
    .action(async (opts: { status?: JobStatus; limit: number }) => {
      const { config } = await loadFromProgram(program, ctx);
      const filter = { ...(opts.status === undefined ? {} : { status: opts.status }), limit: opts.limit };
      const client = await admin(ctx, config);
      const rows = client === null ? openStores(config.dataDir).jobs.list(filter) : await client.listJobs(filter);
      const running = await runningLine(ctx, config.server.port);
      if (running !== null) println(ctx, running);
      for (const job of rows) println(ctx, jobLine(job));
    });

  jobs
    .command("show")
    .description("job row (with its stored result), attempts, transcript paths and artifacts")
    .argument("<id>", "job id", parseId)
    .action(async (id: number) => {
      const { config } = await loadFromProgram(program, ctx);
      const client = await admin(ctx, config);
      if (client !== null) {
        const detail = await client.job(id);
        if (detail === null) return fail(ctx, `job ${id} not found`);
        return printDetail(ctx, config.dataDir, id, detail);
      }
      const stores = openStores(config.dataDir);
      const job = stores.jobs.get(id);
      if (job === null) return fail(ctx, `job ${id} not found`);
      await printDetail(ctx, config.dataDir, id, { job, attempts: stores.attempts.forJob(id), loop: loopOfJob(stores, job) });
    });

  jobs
    .command("retry")
    .description("run the job again: requeue it when serve is running, otherwise run inline; publish-only when an implement result is stored")
    .argument("<id>", "job id", parseId)
    .action(async (id: number) => {
      const loaded = await loadFromProgram(program, ctx, { secrets: CLI_SECRET_NAMES });
      const client = await admin(ctx, loaded.config);
      if (client !== null) {
        try {
          println(ctx, await client.retry(id));
        } catch (err) {
          return fail(ctx, err instanceof AdminError ? err.message : errorMessage(err));
        }
        println(ctx, `steward serve is running; requeued job ${id}`);
        return reportOutcome(ctx, id, await tailOverApi(client, id, ctx));
      }
      const runtime = await buildRuntime(loaded, ctx);
      const { jobs } = runtime.stores;
      const job = jobs.get(id);
      if (job === null) return fail(ctx, `job ${id} not found`);
      println(ctx, retryMode(job));
      if (await answers(ctx.fetchImpl, localHealthUrl(runtime.loaded.config.server.port), HEALTH_TIMEOUT_MS)) {
        if (!jobs.requeue(id)) return fail(ctx, `job ${id} is already running`);
        println(ctx, `steward serve is running; requeued job ${id}`);
        return reportOutcome(ctx, id, await tailJob(runtime.stores, id, ctx));
      }
      reportOutcome(ctx, id, await runInline(runtime, id, ctx));
    });

  jobs
    .command("gc")
    .description("run retention now: worktrees, job directories, deliveries")
    .action(async () => {
      const loaded = await loadFromProgram(program, ctx);
      const { config } = loaded;
      await withRunLock({ loaded }, ctx, async () => {
        const stores = openStores(config.dataDir);
        const root = workRoot(config.dataDir);
        const removed = await sweep({
          workRoot: root,
          jobsDir: jobsDir(config.dataDir),
          keptWorktrees: config.retention.keptWorktrees,
          days: config.retention.days,
          ...retentionProtection(stores, config),
          sessionsDir: sessionsDir(config),
        });
        const deliveries = stores.deliveries.prune(DELIVERY_RETENTION_DAYS);
        println(
          ctx,
          `removed ${removed.removedWorktrees.length} worktrees, ${removed.removedJobDirs.length} job directories, ${removed.removedSessionDirs.length} session directories, ${deliveries} deliveries`,
        );
      });
    });
};
