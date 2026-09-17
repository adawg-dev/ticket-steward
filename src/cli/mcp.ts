import type { Command } from "commander";
import { createCodeHost, startCodeHostMcpServer } from "../codehost/index.js";
import { fail, type CliContext } from "./context.js";

export const registerMcp = (program: Command, ctx: CliContext): void => {
  const mcp = program.command("mcp").description("internal MCP servers spawned for the brain");

  mcp
    .command("codehost")
    .description("stdio MCP server exposing recent_changes and permalink for one worktree; needs the global --config")
    .requiredOption("--workspace <path>", "absolute worktree path")
    .requiredOption("--sha <sha>", "commit the worktree is checked out at")
    .action(async (opts: { workspace: string; sha: string }) => {
      const { config: configPath } = program.opts<{ config?: string }>();
      if (configPath === undefined) return fail(ctx, "mcp codehost requires --config <absolute path to steward.config.ts>");
      const { config, secrets } = await ctx.loadConfig({ configPath });
      await startCodeHostMcpServer({ codehost: createCodeHost(config.codehost, secrets), worktreePath: opts.workspace, sha: opts.sha });
    });
};
