import type { Command } from "commander";
import { shouldEnqueue, STEWARD_BEGIN, STEWARD_END } from "../core/intake.js";
import { runJob } from "../core/pipeline.js";
import type { JobOutcome, RunContext } from "../core/types.js";
import type { JobStatus, Stores } from "../store/index.js";
import { ReadOnlyTracker, type RecordedWrite } from "../tracker/readOnly.js";
import type { TriggerEvent } from "../tracker/types.js";
import { fail, loadFromProgram, println, type CliContext } from "./context.js";
import { reportOutcome, runInline } from "./inline.js";
import { answers, localHealthUrl, sleep } from "./probe.js";
import { buildRuntime, type Runtime } from "./runtime.js";

const HEALTH_TIMEOUT_MS = 2_000;
const POLL_MS = 2_000;
const TERMINAL: JobStatus[] = ["succeeded", "failed", "publish_failed", "skipped"];

const sectionOf = (description: string): string => {
  const begin = description.indexOf(STEWARD_BEGIN);
  const end = description.indexOf(STEWARD_END);
  if (begin === -1 || end === -1) return "(no Enrichment section written)";
  return description.slice(begin, end + STEWARD_END.length);
};

const describeWrite = ({ method, args }: RecordedWrite): string => {
  const [target = "", payload = ""] = args;
  return `${method}(${target}) ${payload.length} chars`;
};

const cliContext = (event: TriggerEvent, jobId: number, attempt: number, dryRun: boolean): RunContext => ({
  jobId,
  attempt,
  issueId: event.issueId,
  identifier: event.identifier,
  teamKey: event.teamKey,
  trigger: event,
  dryRun,
});

const dryRun = async (runtime: Runtime, event: TriggerEvent, ctx: CliContext): Promise<void> => {
  const tracker = new ReadOnlyTracker(runtime.tracker);
  println(ctx, `dry run for ${event.identifier} (${event.issueId}); nothing will be written`);
  const outcome = await runJob(cliContext(event, 0, 1, true), { ...runtime.deps, tracker });
  const description = tracker.writes.find((write) => write.method === "writeDescription")?.args[1] ?? "";
  println(ctx, `--- section ---\n${sectionOf(description)}`);
  println(ctx, `--- recorded writes (${tracker.writes.length}) ---\n${tracker.writes.map(describeWrite).join("\n")}`);
  reportOutcome(ctx, 0, outcome);
};

const tail = async (stores: Stores, jobId: number, ctx: CliContext): Promise<JobOutcome> => {
  let last: JobStatus | null = null;
  for (;;) {
    const job = stores.jobs.get(jobId);
    if (job === null) return fail(ctx, `job ${jobId} disappeared`);
    if (job.status !== last) {
      last = job.status;
      println(ctx, `job ${jobId} ${job.status}`);
    }
    if (TERMINAL.includes(job.status)) {
      return job.status === "succeeded" ? { status: "succeeded" } : { status: "failed", error: job.error ?? job.status, retryable: false };
    }
    await sleep(POLL_MS);
  }
};

export const registerEnrich = (program: Command, ctx: CliContext): void => {
  program
    .command("enrich")
    .description("enrich one ticket: enqueue when serve is running, otherwise run inline")
    .argument("<key>", "issue key or UUID")
    .option("--dry-run", "run the pipeline without writing to the tracker or the store", false)
    .action(async (key: string, opts: { dryRun: boolean }) => {
      const runtime = await buildRuntime(await loadFromProgram(program, ctx), ctx);
      const { config } = runtime.loaded;
      const { id, identifier, teamKey } = await runtime.tracker.resolveIssueId(key);
      const event: TriggerEvent = { kind: "cli", issueId: id, identifier, teamKey };
      if (opts.dryRun) return dryRun(runtime, event, ctx);

      const { jobs } = runtime.stores;
      const decision = shouldEnqueue({
        event,
        allowlist: config.tracker.teams,
        priorSuccess: jobs.hasSucceeded(id),
        hasQueuedJob: jobs.findQueued(id) !== null,
      });
      if (decision.action === "skip") return fail(ctx, decision.reason);
      if (decision.action === "attach") return println(ctx, `${identifier} already has queued job ${jobs.findQueued(id)?.id}`);

      const jobId = jobs.enqueue(event);
      if (await answers(ctx.fetchImpl, localHealthUrl(config.server.port), HEALTH_TIMEOUT_MS)) {
        println(ctx, `steward serve is running; enqueued job ${jobId}`);
        return reportOutcome(ctx, jobId, await tail(runtime.stores, jobId, ctx));
      }
      reportOutcome(ctx, jobId, await runInline(runtime, jobId, ctx));
    });
};
