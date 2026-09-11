import { existsSync } from "node:fs";
import { readdir } from "node:fs/promises";
import type { Command } from "commander";
import { openStores, type Job, type JobStatus } from "../store/index.js";
import { sweep } from "../workspace/retention.js";
import { fail, loadFromProgram, println, type CliContext } from "./context.js";
import { reportOutcome, runInline } from "./inline.js";
import { artifactsDir, jobsDir, workRoot } from "./paths.js";
import { buildRuntime } from "./runtime.js";

const DEFAULT_LIMIT = 20;
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

export const jobLine = (job: Job): string =>
  [job.id, job.status, job.identifier, job.trigger.kind, `attempts=${job.attempts}`, job.createdAt].join("\t");

const pretty = (value: unknown): string => JSON.stringify(value, null, 2);

const listArtifacts = async (dir: string): Promise<string[]> => (existsSync(dir) ? (await readdir(dir)).sort() : []);

export const registerJobs = (program: Command, ctx: CliContext): void => {
  const jobs = program
    .command("jobs")
    .description("list jobs")
    .option("--status <status>", `filter by status (${STATUSES.join(", ")})`, parseStatus)
    .option("--limit <n>", "maximum rows", parseId, DEFAULT_LIMIT)
    .action(async (opts: { status?: JobStatus; limit: number }) => {
      const { config } = await loadFromProgram(program, ctx);
      const rows = openStores(config.dataDir).jobs.list({ ...(opts.status === undefined ? {} : { status: opts.status }), limit: opts.limit });
      for (const job of rows) println(ctx, jobLine(job));
    });

  jobs
    .command("show")
    .description("job row, attempts, transcript paths, artifacts and stored result")
    .argument("<id>", "job id", parseId)
    .action(async (id: number) => {
      const { config } = await loadFromProgram(program, ctx);
      const stores = openStores(config.dataDir);
      const job = stores.jobs.get(id);
      if (job === null) return fail(ctx, `job ${id} not found`);
      const { result, ...row } = job;
      const attempts = stores.attempts.forJob(id);
      println(ctx, `# job\n${pretty(row)}`);
      println(ctx, `# attempts\n${pretty(attempts)}`);
      println(ctx, `# transcripts\n${attempts.map((attempt) => attempt.transcriptPath ?? "(none)").join("\n")}`);
      println(ctx, `# artifacts (${artifactsDir(config.dataDir, id)})\n${(await listArtifacts(artifactsDir(config.dataDir, id))).join("\n")}`);
      println(ctx, `# result\n${pretty(result)}`);
    });

  jobs
    .command("retry")
    .description("run the job again now; publish-only when a result is stored")
    .argument("<id>", "job id", parseId)
    .action(async (id: number) => {
      const runtime = await buildRuntime(await loadFromProgram(program, ctx), ctx);
      const job = runtime.stores.jobs.get(id);
      if (job === null) return fail(ctx, `job ${id} not found`);
      println(ctx, job.result === null ? `job ${id}: full run` : `job ${id}: publish-only (result stored at ${job.resultSha})`);
      reportOutcome(ctx, id, await runInline(runtime, id, ctx));
    });

  jobs
    .command("gc")
    .description("run retention now: worktrees, job directories, deliveries")
    .action(async () => {
      const { config } = await loadFromProgram(program, ctx);
      const stores = openStores(config.dataDir);
      const removed = await sweep({
        workRoot: workRoot(config.dataDir),
        jobsDir: jobsDir(config.dataDir),
        keptWorktrees: config.retention.keptWorktrees,
        days: config.retention.days,
        protect: [],
      });
      const deliveries = stores.deliveries.prune(DELIVERY_RETENTION_DAYS);
      println(ctx, `removed ${removed.removedWorktrees.length} worktrees, ${removed.removedJobDirs.length} job directories, ${deliveries} deliveries`);
    });
};
