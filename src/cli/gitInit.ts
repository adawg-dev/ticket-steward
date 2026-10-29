import { readFile } from "node:fs/promises";
import type { Command } from "commander";
import { gitInit } from "../run/pod.js";
import { RunSpecSchema, type RunSpec } from "../run/protocol.js";
import { injectToken } from "../workspace/mirror.js";
import { scrubCredentials } from "../workspace/git.js";
import { errorMessage, fail, loadFromProgram, println, type CliContext } from "./context.js";

export const registerGitInit = (program: Command, ctx: CliContext): void => {
  program
    .command("git-init")
    .description("run pod init container: clones the repository at the spec's commit with MIRROR_TOKEN, leaving no credential in the clone")
    .requiredOption("--spec <file>", "the run's spec (JSON)")
    .action(async (opts: { spec: string }) => {
      let spec: RunSpec;
      try {
        spec = RunSpecSchema.parse(JSON.parse(await readFile(opts.spec, "utf8")));
        const { config, secrets } = await loadFromProgram(program, ctx, { secrets: ["MIRROR_TOKEN", "MIRROR_USERNAME"] });
        await gitInit({ spec, fetchUrl: injectToken(config.workspace.fetchUrl, secrets.MIRROR_TOKEN, secrets.MIRROR_USERNAME) });
      } catch (err) {
        // Git's messages are scrubbed already; a URL in any other error is scrubbed here.
        return fail(ctx, `git-init: ${scrubCredentials(errorMessage(err))}`);
      }
      println(ctx, `cloned ${spec.checkout.ref ?? "the base"} at ${spec.checkout.sha.slice(0, 12)} into ${spec.worktreePath}`);
    });
};
