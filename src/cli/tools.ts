import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Command } from "commander";
import { createCodeHost } from "../codehost/index.js";
import { execOrbit } from "../orbit/run.js";
import { orbitRemote } from "../orbit/server.js";
import { httpCheckRunner } from "../push/checks.js";
import { MINUTE_MS, pushFromWorktree, type PushResult } from "../push/service.js";
import { RunSpecSchema, type RunSpec } from "../run/protocol.js";
import { postWork, recordingLedger, toolsWork } from "../tools/finish.js";
import { toolsGuard } from "../tools/guard.js";
import { httpLedger } from "../tools/httpLedger.js";
import { parseListen, startToolsServer, toolRoutes, TOOLS_HOST, TOOLS_PORT } from "../tools/server.js";
import { errorMessage, exitWith, fail, loadFromProgram, println, type CliContext } from "./context.js";
import { buildRedactor } from "./runtime.js";

/** The agent container's check endpoint (Task 11's `run-pod`), on the pod's loopback. */
export const AGENT_CHECKS_URL = "http://127.0.0.1:4183";
/** The dispatcher's run API base and the run's tools token, set on the tools container by the run's Job. */
export const CALLBACK_URL_ENV = "STEWARD_CALLBACK_URL";
export const TOOLS_TOKEN_ENV = "STEWARD_TOOLS_TOKEN";

/**
 * The credentials the tools sidecar uses: the code host's API token (also Orbit's), the push token and the mirror's.
 * No model key, tracker key or webhook secret; the push guard adds the overlay's values from the guard file.
 */
export const TOOLS_SECRET_NAMES = ["GITLAB_TOKEN", "GITLAB_PUSH_TOKEN", "GITHUB_TOKEN", "MIRROR_TOKEN", "MIRROR_USERNAME"] as const;

const readSpec = async (path: string): Promise<RunSpec> => RunSpecSchema.parse(JSON.parse(await readFile(path, "utf8")));

export const registerTools = (program: Command, ctx: CliContext): void => {
  program
    .command("tools")
    .description("run pod sidecar: serves the code host, push and Orbit MCP tools over HTTP on 127.0.0.1 with the steward's credentials")
    .requiredOption("--spec <file>", "the run's spec (JSON)")
    .option("--listen <address>", "127.0.0.1:<port> to listen on", `${TOOLS_HOST}:${TOOLS_PORT}`)
    .option("--guard <file>", "render-overlay's guard file: the overlay's real values and placeholders, which no commit may carry")
    .action(async (opts: { spec: string; listen: string; guard?: string }) => {
      let spec: RunSpec;
      let listen: { host: string; port: number };
      try {
        spec = await readSpec(opts.spec);
        listen = parseListen(opts.listen);
      } catch (err) {
        return fail(ctx, `tools: ${errorMessage(err)}`);
      }
      const callbackUrl = process.env[CALLBACK_URL_ENV];
      const token = process.env[TOOLS_TOKEN_ENV];
      if (callbackUrl === undefined || callbackUrl === "" || token === undefined || token === "") return fail(ctx, `tools: ${CALLBACK_URL_ENV} and ${TOOLS_TOKEN_ENV} must be set`);

      const loaded = await loadFromProgram(program, ctx, { secrets: TOOLS_SECRET_NAMES });
      const { config, secrets } = loaded;
      const redactor = await buildRedactor(loaded);
      const guard = toolsGuard({ guardFile: opts.guard ?? null, overlayDir: config.workspace.overlayDir, skillsDir: config.workspace.skillsDir, secrets });
      const { ledger, lastPushed } = recordingLedger(httpLedger({ baseUrl: callbackUrl, runId: spec.runId, token }));
      const checksTimeoutMs = ((config.implement?.checksTimeoutMinutes ?? 0) + 1) * MINUTE_MS;
      const deps = {
        config,
        secrets,
        redactor,
        // The pod's worktree is a clone: its own git directory is the one the push checks must still find.
        mirror: { path: join(spec.worktreePath, ".git") },
        ledger,
        checks: httpCheckRunner(AGENT_CHECKS_URL, checksTimeoutMs),
        guard,
      };

      const server = await startToolsServer({
        listen,
        routes: toolRoutes({
          spec,
          codehost: createCodeHost(config.codehost, secrets),
          orbit: orbitRemote({ exec: execOrbit, dataDir: config.dataDir, worktreePath: spec.worktreePath, codehost: config.codehost, secrets }),
          push: (target) => (request) =>
            pushFromWorktree({ deps, target, branchType: request.branchType ?? null, ...(request.note === undefined ? {} : { note: request.note }) }).catch(
              (err: unknown): PushResult => ({ ok: false, reason: "push failed", detail: redactor.redact(errorMessage(err)) }),
            ),
        }),
        finish: async () => {
          const read = await toolsWork({ spec, pushedSha: lastPushed(), guard });
          const work = { ...read, unpushed: redactor.redact(read.unpushed) };
          await postWork({ baseUrl: callbackUrl, token, work, warn: (message) => void ctx.stderr.write(`tools: ${message}\n`) });
          return work;
        },
      });
      println(ctx, `tools listening on ${server.url}`);
      const stop = (): void => void server.close().then(() => exitWith(ctx, 0));
      process.once("SIGTERM", stop);
      process.once("SIGINT", stop);
    });
};
