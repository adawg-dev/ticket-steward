import type { Command } from "commander";
import { buildServer } from "../server/app.js";
import { startWorker } from "../worker/index.js";
import { errorMessage, exitWith, fail, loadFromProgram, println, type CliContext } from "./context.js";
import { buildRuntime } from "./runtime.js";

export const registerServe = (program: Command, ctx: CliContext): void => {
  program
    .command("serve")
    .description("run the webhook server and the job worker; takes run.lock")
    .action(async () => {
      const runtime = await buildRuntime(await loadFromProgram(program, ctx), ctx);
      const { config, secrets } = runtime.loaded;
      let worker;
      try {
        worker = startWorker(runtime.deps);
      } catch (err) {
        return fail(ctx, errorMessage(err));
      }
      const app = buildServer({ config, secrets, stores: runtime.stores, tracker: runtime.tracker, workerState: worker.state, fetchImpl: ctx.fetchImpl });
      await app.listen({ port: config.server.port });
      println(ctx, `listening on http://localhost:${config.server.port} (public ${config.server.publicUrl})`);

      const shutdown = async (): Promise<void> => {
        println(ctx, "shutting down: waiting for the in-flight job");
        await worker.stop();
        await app.close();
        exitWith(ctx, 0);
      };
      process.once("SIGINT", () => void shutdown());
      process.once("SIGTERM", () => void shutdown());
    });
};
