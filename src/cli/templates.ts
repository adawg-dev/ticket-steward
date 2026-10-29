import type { Command } from "commander";
import { connectAdmin } from "./client.js";
import { errorMessage, fail, loadFromProgram, println, type CliContext, type TemplateListing } from "./context.js";
import { NO_ADMIN_API } from "./runtime.js";

export const registerTemplates = (program: Command, ctx: CliContext): void => {
  program
    .command("templates")
    .description("list issue templates for the workspace and allowlisted teams, as steward serve reads them from Linear")
    .action(async () => {
      // The dispatcher reads Linear with its own token; the CLI holds no Linear credential.
      const { config } = await loadFromProgram(program, ctx, { withoutSecrets: true });
      const client = await connectAdmin(ctx, config);
      if (client === null) return fail(ctx, NO_ADMIN_API);
      let listings: TemplateListing[];
      try {
        listings = await client.templates();
      } catch (err) {
        return fail(ctx, errorMessage(err));
      }
      if (listings.length === 0) return println(ctx, "no issue templates found");
      for (const { scope, template } of listings) {
        println(ctx, `${scope}\t${template.name}\trequired: ${template.requiredFields.join(", ")}`);
      }
    });
};
