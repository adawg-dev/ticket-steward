import type { Template } from "@linear/sdk";
import type { TemplateListing } from "../types.js";
import type { LinearToken } from "./auth.js";
import { createLinearClient } from "./client.js";
import { toTemplateSummary } from "./templates.js";

const WORKSPACE_SCOPE = "workspace";

const issueTemplates = (scope: string, templates: Template[]): TemplateListing[] =>
  templates.filter((template) => template.type === "issue").map((template) => ({ scope, template: toTemplateSummary(template) }));

/**
 * Workspace templates and the templates of the allowlisted teams (every team when the allowlist is empty), read with
 * the dispatcher's app token: `steward templates` asks for them through the admin API.
 */
export const listIssueTemplates = async (token: LinearToken, teamKeys: string[]): Promise<TemplateListing[]> => {
  const client = createLinearClient(await token.get());
  const [organization, teams] = await Promise.all([client.organization, client.teams()]);
  const selected = teams.nodes.filter((team) => teamKeys.length === 0 || teamKeys.includes(team.key));
  const listings = issueTemplates(WORKSPACE_SCOPE, (await organization.templates()).nodes);
  for (const team of selected) listings.push(...issueTemplates(team.key, (await team.templates()).nodes));
  return listings;
};
