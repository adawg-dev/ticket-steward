import type { Command } from "commander";
import { shouldEnqueue, STEWARD_BEGIN, STEWARD_END } from "../core/intake.js";
import { runJob } from "../core/pipeline.js";
import type { RunContext } from "../core/types.js";
import { ReadOnlyTracker, type RecordedWrite } from "../tracker/readOnly.js";
import type { TriggerEvent } from "../tracker/types.js";
import { fail, loadFromProgram, println, type CliContext } from "./context.js";
import { reportOutcome, runInline, tailJob, withRunLock } from "./inline.js";
import { answers, localHealthUrl } from "./probe.js";
import { buildRuntime, type Runtime } from "./runtime.js";

const HEALTH_TIMEOUT_MS = 2_000;

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

/** Runs the pipeline against a recording tracker under run.lock, so it never overlaps a live job. */
const dryRun = async (runtime: Runtime, event: TriggerEvent, ctx: CliContext): Promise<void> => {
  const tracker = new ReadOnlyTracker(runtime.tracker);
  println(ctx, `dry run for ${event.identifier} (${event.issueId}); nothing will be written`);
  const outcome = await withRunLock(runtime, ctx, () => runJob(cliContext(event, 0, 1, true), { ...runtime.deps, tracker }));
  const description = tracker.writes.find((write) => write.method === "writeDescription")?.args[1] ?? "";
  println(ctx, `--- section ---\n${sectionOf(description)}`);
  println(ctx, `--- recorded writes (${tracker.writes.length}) ---\n${tracker.writes.map(describeWrite).join("\n")}`);
  reportOutcome(ctx, 0, outcome);
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
      const { jobs } = runtime.stores;
      const decision = shouldEnqueue({
        event,
        allowlist: config.tracker.teams,
        priorSuccess: opts.dryRun ? false : jobs.hasSucceeded(id),
        hasQueuedJob: opts.dryRun ? false : jobs.findQueued(id) !== null,
      });
      if (decision.action === "skip") return fail(ctx, decision.reason);
      if (opts.dryRun) return dryRun(runtime, event, ctx);
      if (decision.action === "attach") return println(ctx, `${identifier} already has queued job ${jobs.findQueued(id)?.id}`);

      const jobId = jobs.enqueue(event);
      if (await answers(ctx.fetchImpl, localHealthUrl(config.server.port), HEALTH_TIMEOUT_MS)) {
        println(ctx, `steward serve is running; enqueued job ${jobId}`);
        return reportOutcome(ctx, jobId, await tailJob(runtime.stores, jobId, ctx));
      }
      reportOutcome(ctx, jobId, await runInline(runtime, jobId, ctx));
    });
};
