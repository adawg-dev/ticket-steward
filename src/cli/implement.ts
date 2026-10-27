import type { Command } from "commander";
import { jobKindFor, shouldEnqueue } from "../core/intake.js";
import type { RunContext } from "../core/types.js";
import { runImplement } from "../implement/pipeline.js";
import { ReadOnlyTracker } from "../tracker/readOnly.js";
import type { TriggerEvent } from "../tracker/types.js";
import { fail, loadFromProgram, println, type CliContext } from "./context.js";
import { reportOutcome, runInline, tailJob, withRunLock } from "./inline.js";
import { answers, localHealthUrl } from "./probe.js";
import { buildRuntime } from "./runtime.js";

const HEALTH_TIMEOUT_MS = 2_000;

export const registerImplement = (program: Command, ctx: CliContext): void => {
  program
    .command("implement")
    .description("implement one ticket on a new branch: enqueue when serve is running, otherwise run inline")
    .argument("<key>", "issue key or UUID")
    .option("--dry-run", "run up to the steward's checks, print the would-be commit, write nothing", false)
    .action(async (key: string, opts: { dryRun: boolean }) => {
      const runtime = await buildRuntime(await loadFromProgram(program, ctx), ctx);
      const { config } = runtime.loaded;
      if (config.implement === undefined) return fail(ctx, "implement is not configured (add an implement block and GITLAB_PUSH_TOKEN)");
      const { id, identifier, teamKey } = await runtime.tracker.resolveIssueId(key);
      const event: TriggerEvent = { kind: "cli", issueId: id, identifier, teamKey, action: "implement" };
      const { jobs } = runtime.stores;
      const kind = jobKindFor(event);
      const decision = shouldEnqueue({
        event,
        allowlist: config.tracker.teams,
        gatewayIssues: config.tracker.gatewayIssues,
        priorSuccess: false,
        hasQueuedJob: opts.dryRun ? false : jobs.findQueued(id, kind) !== null,
      });
      if (decision.action === "skip") return fail(ctx, decision.reason);
      if (opts.dryRun) {
        const tracker = new ReadOnlyTracker(runtime.tracker);
        const dryCtx: RunContext = { jobId: 0, attempt: 1, issueId: id, identifier, teamKey, trigger: event, dryRun: true };
        println(ctx, `dry run for ${identifier}; nothing will be committed, pushed or written`);
        const outcome = await withRunLock(runtime, ctx, () => runImplement(dryCtx, { ...runtime.deps, tracker }));
        if (outcome.status === "succeeded" && outcome.warning !== undefined) println(ctx, outcome.warning);
        return reportOutcome(ctx, 0, outcome.status === "succeeded" ? { status: "succeeded" } : outcome);
      }
      if (decision.action === "attach") return println(ctx, `${identifier} already has queued implement job ${jobs.findQueued(id, kind)?.id}`);
      const jobId = jobs.enqueue(event);
      if (await answers(ctx.fetchImpl, localHealthUrl(config.server.port), HEALTH_TIMEOUT_MS)) {
        println(ctx, `steward serve is running; enqueued job ${jobId}`);
        return reportOutcome(ctx, jobId, await tailJob(runtime.stores, jobId, ctx));
      }
      reportOutcome(ctx, jobId, await runInline(runtime, jobId, ctx));
    });
};
