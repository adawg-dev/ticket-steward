import { Command } from "commander";
import { registerChat } from "./chat.js";
import { defaultContext, exitWith, type CliContext } from "./context.js";
import { registerDoctor } from "./doctor.js";
import { registerGitInit } from "./gitInit.js";
import { registerImplement } from "./implement.js";
import { registerInit } from "./init.js";
import { registerJobs } from "./jobs.js";
import { registerKeyproxy } from "./keyproxy.js";
import { registerMcp } from "./mcp.js";
import { registerMirror } from "./mirror.js";
import { registerOverlay } from "./overlay.js";
import { registerRenderOverlay } from "./renderOverlay.js";
import { registerRunPod } from "./runPod.js";
import { registerServe } from "./serve.js";
import { registerSessions } from "./sessions.js";
import { registerSettings } from "./settings.js";
import { registerTemplates } from "./templates.js";
import { registerTools } from "./tools.js";

export const buildProgram = (ctx: CliContext = defaultContext()): Command => {
  const program = new Command("steward")
    .description("implements the Linear tickets assigned to the steward and follows their merge requests")
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
  registerChat(program, ctx);
  registerJobs(program, ctx);
  registerSettings(program, ctx);
  registerTemplates(program, ctx);
  registerMcp(program, ctx);
  registerTools(program, ctx);
  registerKeyproxy(program, ctx);
  registerRenderOverlay(program, ctx);
  registerSessions(program, ctx);
  registerGitInit(program, ctx);
  registerRunPod(program, ctx);
  return program;
};
