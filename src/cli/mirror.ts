import type { Command } from "commander";
import { injectToken, Mirror } from "../workspace/mirror.js";
import { loadFromProgram, println, type CliContext } from "./context.js";
import { mirrorPath } from "./paths.js";
import { openMirror } from "./runtime.js";

/** The mirror's credential only. */
const MIRROR_SECRET_NAMES = ["MIRROR_TOKEN", "MIRROR_USERNAME"] as const;

export const registerMirror = (program: Command, ctx: CliContext): void => {
  const mirror = program.command("mirror").description("manage the steward-owned bare mirror of the repository");

  mirror
    .command("init")
    .description("clone the bare mirror into <dataDir>/repo.git")
    .action(async () => {
      const { config, secrets } = await loadFromProgram(program, ctx, { secrets: MIRROR_SECRET_NAMES });
      const path = mirrorPath(config.dataDir);
      await Mirror.init(path, injectToken(config.workspace.fetchUrl, secrets.MIRROR_TOKEN, secrets.MIRROR_USERNAME));
      println(ctx, `mirror created at ${path}`);
    });

  mirror
    .command("fetch")
    .description("fetch the mirror and print the base branch commit")
    .action(async () => {
      const loaded = await loadFromProgram(program, ctx, { secrets: MIRROR_SECRET_NAMES });
      const repo = openMirror(loaded);
      await repo.fetch();
      println(ctx, `${loaded.config.workspace.baseBranch} ${await repo.resolveSha(loaded.config.workspace.baseBranch)}`);
    });
};
