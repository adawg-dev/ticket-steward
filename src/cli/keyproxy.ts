import type { Command } from "commander";
import { KEYPROXY_HOST, KEYPROXY_PORT, modelUpstream, startKeyproxy, type ModelUpstream } from "../keyproxy/server.js";
import { parseListen } from "../tools/server.js";
import { errorMessage, exitWith, fail, loadFromProgram, println, type CliContext } from "./context.js";

export const registerKeyproxy = (program: Command, ctx: CliContext): void => {
  program
    .command("keyproxy")
    .description("run pod sidecar: forwards the agent's model requests on 127.0.0.1 with the steward's model credential in place of its dummy token")
    .option("--listen <address>", "127.0.0.1:<port> to listen on", `${KEYPROXY_HOST}:${KEYPROXY_PORT}`)
    .action(async (opts: { listen: string }) => {
      let listen: { host: string; port: number };
      let upstream: ModelUpstream;
      try {
        listen = parseListen(opts.listen, "keyproxy");
        upstream = modelUpstream((await loadFromProgram(program, ctx)).secrets);
      } catch (err) {
        return fail(ctx, `keyproxy: ${errorMessage(err)}`);
      }
      const server = await startKeyproxy({ listen, upstream, fetchImpl: ctx.fetchImpl });
      println(ctx, `keyproxy listening on ${server.url}, forwarding to ${new URL(upstream.baseUrl).origin}`);
      const stop = (): void => void server.close().then(() => exitWith(ctx, 0));
      process.once("SIGTERM", stop);
      process.once("SIGINT", stop);
    });
};
