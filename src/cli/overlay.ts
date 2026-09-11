import type { Command } from "commander";
import { syncOverlayFromCheckout } from "../workspace/overlay.js";
import { loadFromProgram, println, type CliContext } from "./context.js";

const DENY_PATTERNS = [/prod/i];

const collect = (value: string, previous: string[]): string[] => [...previous, value];

export const registerOverlay = (program: Command, ctx: CliContext): void => {
  const overlay = program.command("overlay").description("manage the env-file overlay copied into every worktree");

  overlay
    .command("sync")
    .description("copy gitignored .env* files from a checkout into overlayDir")
    .requiredOption("--from <path>", "checkout whose env files hold the sandbox credentials")
    .option("--allow-pattern <re>", "accept values matching this pattern even when a deny pattern matches (repeatable)", collect, [])
    .action(async (opts: { from: string; allowPattern: string[] }) => {
      const { config } = await loadFromProgram(program, ctx);
      const { copied, refused } = await syncOverlayFromCheckout(opts.from, config.workspace.overlayDir, {
        denyPatterns: DENY_PATTERNS,
        allowPatterns: opts.allowPattern.map((pattern) => new RegExp(pattern)),
      });
      for (const file of copied) println(ctx, `copied ${file}`);
      for (const { file, reason } of refused) println(ctx, `refused ${file}: ${reason}`);
    });
};
