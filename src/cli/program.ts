import { Command } from "commander";
import { defaultContext, exitWith, type CliContext } from "./context.js";
import { registerDoctor } from "./doctor.js";
import { registerFix } from "./fix.js";
import { registerImplement } from "./implement.js";
import { registerInit } from "./init.js";
import { registerJobs } from "./jobs.js";
import { registerMcp } from "./mcp.js";
import { registerMirror } from "./mirror.js";
import { registerOverlay } from "./overlay.js";
import { registerServe } from "./serve.js";
import { registerTemplates } from "./templates.js";

export const buildProgram = (ctx: CliContext = defaultContext()): Command => {
  const program = new Command("steward")
    .description("implements Linear tickets labelled for the agent and follows their merge requests")
    .option("--config <path>", "path to steward.config.ts (default: ./steward.config.ts)")
    .configureOutput({
      writeOut: (text) => void ctx.stdout.write(text),
      writeErr: (text) => void ctx.stderr.write(text),
    })
    .exitOverride((err) => exitWith(ctx, err.exitCode));
  registerInit(program, ctx);
  registerDoctor(program, ctx);
  registerMirror(program, ctx);
  registerOverlay(program, ctx);
  registerServe(program, ctx);
  registerImplement(program, ctx);
  registerFix(program, ctx);
  registerJobs(program, ctx);
  registerTemplates(program, ctx);
  registerMcp(program, ctx);
  return program;
};
