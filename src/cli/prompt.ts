import { readFile } from "node:fs/promises";
import type { Command } from "commander";
import { renderTemplatesMarkdown, renderTicketMarkdown } from "../core/context.js";
import { renderPrompt } from "../core/prompt.js";
import { openStores } from "../store/index.js";
import { loadFromProgram, type CliContext } from "./context.js";
import { artifactsDir } from "./paths.js";
import { openMirror, openTracker } from "./runtime.js";

const WORKSPACE_PLACEHOLDER = "<worktree>";
const JOB_PLACEHOLDER = "<jobId>";

export const registerPrompt = (program: Command, ctx: CliContext): void => {
  const prompt = program.command("prompt").description("inspect the enrichment prompt");

  prompt
    .command("show")
    .description("print the prompt template")
    .action(async () => {
      const { config } = await loadFromProgram(program, ctx);
      ctx.stdout.write(await readFile(config.prompt, "utf8"));
    });

  prompt
    .command("render")
    .description("print the prompt a job for the ticket would receive")
    .argument("<key>", "issue key or UUID")
    .action(async (key: string) => {
      const loaded = await loadFromProgram(program, ctx);
      const { config } = loaded;
      const tracker = openTracker(loaded, openStores(config.dataDir), ctx);
      const { id, teamKey } = await tracker.resolveIssueId(key);
      const [bundle, sha, template] = await Promise.all([
        tracker.fetchTicket(id),
        openMirror(loaded).resolveSha(config.workspace.baseBranch),
        readFile(config.prompt, "utf8"),
      ]);
      ctx.stdout.write(
        renderPrompt(template, {
          ticket: renderTicketMarkdown(bundle),
          templates: renderTemplatesMarkdown(bundle),
          workspacePath: WORKSPACE_PLACEHOLDER,
          baseBranch: config.workspace.baseBranch,
          sha,
          artifactsDir: artifactsDir(config.dataDir, JOB_PLACEHOLDER),
          teamKey,
          teamName: bundle.team.name,
          stewardPort: config.workspace.port,
          operatorInstructions: "",
        }),
      );
    });
};
