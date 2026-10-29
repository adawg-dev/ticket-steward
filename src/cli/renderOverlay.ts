import type { Command } from "commander";
import { awsSecretFetcher, type SecretFetcher } from "../config/secretSource.js";
import { renderOverlay, writeRenderedOverlay, type RenderedOverlay } from "../overlay/template.js";
import { errorMessage, fail, loadFromProgram, println, type CliContext } from "./context.js";

const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? "" : "s"}`;

export const registerRenderOverlay = (program: Command, ctx: CliContext): void => {
  program
    .command("render-overlay")
    .description("run pod init container: renders the overlay template with placeholders for the agent and the real values for egress and tools")
    .option("--template <dir>", "the overlay template (default: workspace.overlayTemplateDir)")
    .requiredOption("--agent-out <dir>", "where the agent's env files go; they hold placeholders only")
    .requiredOption("--rules-out <file>", "the egress rules (real values), written mode 0600")
    .requiredOption("--guard-out <file>", "the secret guard's values (real values and placeholders), written mode 0600")
    .action(async (opts: { template?: string; agentOut: string; rulesOut: string; guardOut: string }) => {
      let rendered: RenderedOverlay;
      try {
        // The template's ids are read directly below; no steward secret is needed here.
        const { config } = await loadFromProgram(program, ctx, { withoutSecrets: true });
        const templateDir = opts.template ?? config.workspace.overlayTemplateDir;
        if (templateDir === undefined) throw new Error("no --template given and workspace.overlayTemplateDir is not set");
        const secrets = config.secrets ?? { source: "file" };
        let fetcher: SecretFetcher | undefined = ctx.factories?.secretFetcher;
        if (fetcher === undefined) {
          if (secrets.source !== "aws") throw new Error('overlay secrets come from Secrets Manager; set secrets.source to "aws"');
          fetcher = awsSecretFetcher(secrets.region);
        }
        rendered = await renderOverlay({ templateDir, fetcher });
        await writeRenderedOverlay(rendered, opts);
      } catch (err) {
        return fail(ctx, `render-overlay: ${errorMessage(err)}`);
      }
      println(ctx, `rendered ${plural(rendered.files.length, "file")} with ${plural(rendered.rules.length, "egress rule")}`);
    });
};
