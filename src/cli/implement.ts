import type { Command } from "commander";
import type { RunContext } from "../core/types.js";
import { previewImplementPrompt } from "../implement/pipeline.js";
import { errorMessage, fail, loadFromProgram, println, type CliContext } from "./context.js";
import { buildRuntime } from "./runtime.js";

/** Assigning the steward in Linear is the only way to start a job; the CLI previews the prompt only. */
export const ASSIGN_TO_START = "assign the steward in Linear to start work; steward implement only previews the prompt (--dry-run)";

export const registerImplement = (program: Command, ctx: CliContext): void => {
  program
    .command("implement")
    .description("preview the implement prompt for one ticket (--dry-run); work starts only by assigning the steward in Linear")
    .argument("<key>", "issue key or UUID")
    .option("--dry-run", "print the prompt a run on the ticket would get, read through steward serve; runs and writes nothing", false)
    .action(async (key: string, opts: { dryRun: boolean }) => {
      if (!opts.dryRun) return fail(ctx, ASSIGN_TO_START);
      // The Linear app's credentials stay in the dispatcher: the ticket comes from its admin API.
      const runtime = await buildRuntime(await loadFromProgram(program, ctx), ctx);
      if (runtime.loaded.config.implement === undefined) return fail(ctx, "implement is not configured (add an implement block)");
      let prompt: string;
      try {
        const bundle = await runtime.tracker.fetchTicket(key);
        const { id, identifier, team } = bundle;
        const dryCtx: RunContext = { jobId: 0, attempt: 1, issueId: id, identifier, teamKey: team.key, trigger: { kind: "cli", issueId: id, identifier, teamKey: team.key, action: "implement" }, dryRun: true };
        prompt = await previewImplementPrompt(dryCtx, runtime.deps, bundle);
      } catch (err) {
        return fail(ctx, `implement --dry-run: ${errorMessage(err)}`);
      } finally {
        runtime.stores.db.close();
      }
      println(ctx, prompt);
    });
};
