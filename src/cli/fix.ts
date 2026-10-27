import type { Command } from "commander";
import type { TriggerEvent } from "../tracker/types.js";
import { fail, loadFromProgram, println, type CliContext } from "./context.js";
import { reportOutcome, runInline, tailJob } from "./inline.js";
import { answers, localHealthUrl } from "./probe.js";
import { buildRuntime } from "./runtime.js";

const HEALTH_TIMEOUT_MS = 2_000;

export const registerFix = (program: Command, ctx: CliContext): void => {
  program
    .command("fix")
    .description("restart a handed-back Greptile fix loop, leaving labels alone: enqueue when serve is running, otherwise run inline")
    .argument("<key>", "issue key or UUID")
    .action(async (key: string) => {
      const runtime = await buildRuntime(await loadFromProgram(program, ctx), ctx);
      const { config } = runtime.loaded;
      if (config.greptile === undefined) return fail(ctx, "greptile is not configured (add a greptile block)");
      const { id, identifier, teamKey } = await runtime.tracker.resolveIssueId(key);
      const { jobs, loops } = runtime.stores;
      const loop = loops.latestForIssue(id);
      if (loop?.state !== "handed_back") return fail(ctx, `${identifier} has no handed-back fix loop`);
      const queued = jobs.findQueued(id, "restart");
      if (queued !== null) return println(ctx, `${identifier} already has queued restart job ${queued.id}`);
      const event: TriggerEvent = { kind: "loop", issueId: id, identifier, teamKey, loopId: loop.id, step: "restart", labelDriven: false };
      const jobId = jobs.enqueue(event);
      if (await answers(ctx.fetchImpl, localHealthUrl(config.server.port), HEALTH_TIMEOUT_MS)) {
        println(ctx, `steward serve is running; enqueued job ${jobId}`);
        return reportOutcome(ctx, jobId, await tailJob(runtime.stores, jobId, ctx));
      }
      reportOutcome(ctx, jobId, await runInline(runtime, jobId, ctx));
    });
};
