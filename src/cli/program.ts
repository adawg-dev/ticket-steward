import { Command } from "commander";
import { registerAuth } from "./auth.js";
import { defaultContext, exitWith, type CliContext } from "./context.js";
import { registerDoctor } from "./doctor.js";
import { registerEnrich } from "./enrich.js";
import { registerInit } from "./init.js";
import { registerJobs } from "./jobs.js";
import { registerMcp } from "./mcp.js";
import { registerMirror } from "./mirror.js";
import { registerOverlay } from "./overlay.js";
import { registerPrompt } from "./prompt.js";
import { registerServe } from "./serve.js";
import { registerTemplates } from "./templates.js";

export const buildProgram = (ctx: CliContext = defaultContext()): Command => {
  const program = new Command("steward")
    .description("Linear ticket-enrichment bot")
    .option("--config <path>", "path to steward.config.ts (default: ./steward.config.ts)")
    .configureOutput({
      writeOut: (text) => void ctx.stdout.write(text),
      writeErr: (text) => void ctx.stderr.write(text),
    })
    .exitOverride((err) => exitWith(ctx, err.exitCode));
  registerInit(program, ctx);
  registerDoctor(program, ctx);
  registerAuth(program, ctx);
  registerMirror(program, ctx);
  registerOverlay(program, ctx);
  registerServe(program, ctx);
  registerEnrich(program, ctx);
  registerJobs(program, ctx);
  registerTemplates(program, ctx);
  registerPrompt(program, ctx);
  registerMcp(program, ctx);
  return program;
};
