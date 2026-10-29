import type { Command } from "commander";
import { createCodeHost, startCodeHostMcpServer } from "../codehost/index.js";
import { execOrbit } from "../orbit/run.js";
import { orbitRemote, startOrbitMcpServer } from "../orbit/server.js";
import { storeLedger } from "../push/ledger.js";
import { pushFromWorktree, type PushResult } from "../push/service.js";
import { startPushMcpServer } from "../push/server.js";
import { PushTargetSchema, type PushTarget } from "../push/target.js";
import { openStores } from "../store/index.js";
import { errorMessage, fail, type CliContext } from "./context.js";
import { buildRedactor, openMirror, openTracker } from "./runtime.js";

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

  mcp
    .command("push")
    .description("stdio MCP server exposing push for one run's worktree; loads the push token from the config's .env")
    .requiredOption("--target <json>", "the run's push target (job, worktree, ticket, branch, base)")
    .action(async (opts: { target: string }) => {
      const { config: configPath } = program.opts<{ config?: string }>();
      if (configPath === undefined) return fail(ctx, "mcp push requires --config <absolute path to steward.config.ts>");
      let target: PushTarget;
      try {
        target = PushTargetSchema.parse(JSON.parse(opts.target));
      } catch (err) {
        return fail(ctx, `mcp push: invalid --target: ${errorMessage(err)}`);
      }
      const loaded = await ctx.loadConfig({ configPath });
      const redactor = await buildRedactor(loaded);
      const ledger = storeLedger({ stores: openStores(loaded.config.dataDir), tracker: openTracker(loaded, ctx).tracker });
      const deps = { config: loaded.config, secrets: loaded.secrets, mirror: openMirror(loaded), ledger, redactor };
      await startPushMcpServer({
        push: (request) =>
          pushFromWorktree({ deps, target, branchType: request.branchType ?? null, ...(request.note === undefined ? {} : { note: request.note }) }).catch(
            (err: unknown): PushResult => ({ ok: false, reason: "push failed", detail: redactor.redact(errorMessage(err)) }),
          ),
      });
    });

  mcp
    .command("orbit")
    .description("stdio MCP server exposing read-only Orbit tools for one worktree; loads GITLAB_TOKEN from the config's .env")
    .requiredOption("--workspace <path>", "absolute worktree path")
    .action(async (opts: { workspace: string }) => {
      const { config: configPath } = program.opts<{ config?: string }>();
      if (configPath === undefined) return fail(ctx, "mcp orbit requires --config <absolute path to steward.config.ts>");
      const { config, secrets } = await ctx.loadConfig({ configPath });
      await startOrbitMcpServer(orbitRemote({ exec: execOrbit, dataDir: config.dataDir, worktreePath: opts.workspace, codehost: config.codehost, secrets }));
    });
};
