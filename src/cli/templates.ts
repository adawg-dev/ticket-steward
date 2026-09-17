import { LinearClient, type Template } from "@linear/sdk";
import type { Command } from "commander";
import type { Secrets } from "../config/load.js";
import { openStores, type Stores } from "../store/index.js";
import { LinearAuth, toTemplateSummary } from "../tracker/linear/index.js";
import { loadFromProgram, println, type CliContext, type TemplateLister, type TemplateListing } from "./context.js";

const WORKSPACE_SCOPE = "workspace";

const issueTemplates = (scope: string, templates: Template[]): TemplateListing[] =>
  templates.filter((template) => template.type === "issue").map((template) => ({ scope, template: toTemplateSummary(template) }));

/** Lists workspace templates and the templates of the allowlisted teams (every team when the allowlist is empty). */
export const linearTemplateLister = (stores: Pick<Stores, "tokens">, secrets: Secrets, fetchImpl: typeof fetch): TemplateLister => ({
  listTemplates: async (teamKeys) => {
    const { LINEAR_CLIENT_ID: clientId, LINEAR_CLIENT_SECRET: clientSecret } = secrets;
    if (clientId === undefined || clientSecret === undefined) throw new Error("LINEAR_CLIENT_ID and LINEAR_CLIENT_SECRET must be set in .env");
    const auth = new LinearAuth(stores.tokens, { clientId, clientSecret }, fetchImpl);
    const client = new LinearClient({ accessToken: await auth.accessToken() });
    const [organization, teams] = await Promise.all([client.organization, client.teams()]);
    const selected = teams.nodes.filter((team) => teamKeys.length === 0 || teamKeys.includes(team.key));
    const listings = issueTemplates(WORKSPACE_SCOPE, (await organization.templates()).nodes);
    for (const team of selected) listings.push(...issueTemplates(team.key, (await team.templates()).nodes));
    return listings;
  },
});

export const registerTemplates = (program: Command, ctx: CliContext): void => {
  program
    .command("templates")
    .description("list issue templates for the workspace and allowlisted teams")
    .action(async () => {
      const { config, secrets } = await loadFromProgram(program, ctx);
      const lister = ctx.factories?.templates ?? linearTemplateLister(openStores(config.dataDir), secrets, ctx.fetchImpl);
      const listings = await lister.listTemplates(config.tracker.teams);
      if (listings.length === 0) return println(ctx, "no issue templates found");
      for (const { scope, template } of listings) {
        println(ctx, `${scope}\t${template.name}\trequired: ${template.requiredFields.join(", ")}`);
      }
    });
};
