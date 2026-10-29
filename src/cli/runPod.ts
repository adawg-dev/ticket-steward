import { readFile } from "node:fs/promises";
import type { Command } from "commander";
import { claudeMcpServer, CLEANUP_PERIOD_DAYS } from "../brain/claudeCode.js";
import type { runBrainDetached } from "../brain/spawn.js";
import type { BrainInput, BrainRun } from "../brain/types.js";
import { chatSettings } from "../chat/hook.js";
import { MINUTE_MS } from "../core/workspace.js";
import {
  EGRESS_CA_FILE,
  POD_OVERLAY_DIR,
  POD_PORTS,
  POD_WAIT_PORTS,
  POD_WAIT_TIMEOUT_MS,
  runPod,
  TOOLS_URL,
} from "../run/pod.js";
import { RunSpecSchema, type RunSpec } from "../run/protocol.js";
import { parseListen, TOOLS_HOST } from "../tools/server.js";
import { chatArgs, claudeExecutable, spawnInteractive } from "./chat.js";
import { errorMessage, fail, loadFromProgram, println, type CliContext } from "./context.js";
import { binPath } from "./paths.js";
import { CALLBACK_URL_ENV } from "./tools.js";

/** The run's runner token, set on the agent container by the run's Job: it may only post this run's report. */
export const RUNNER_TOKEN_ENV = "STEWARD_RUNNER_TOKEN";

interface RunPodOptions {
  spec: string;
  overlay: string;
  egressCa: string;
  toolsUrl: string;
  waitFor: string;
  waitSeconds: string;
  checksListen: string;
}

const parsePorts = (value: string): number[] =>
  value
    .split(",")
    .filter((part) => part.trim() !== "")
    .map((part) => {
      const port = Number(part.trim());
      if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error(`--wait-for takes ports, got ${JSON.stringify(part)}`);
      return port;
    });

/**
 * The interactive "brain" of a chat pod: Claude Code resumed on the container's TTY, with the run's env and MCP servers
 * and the brain's tool rules as its PreToolUse hook (denied paths on the hook's command line: this container cannot
 * load the config's secrets). Done when the person leaves it.
 */
const interactiveBrain =
  (ctx: CliContext, configPath: string): typeof runBrainDetached =>
  async (brain, input: BrainInput): Promise<BrainRun> => {
    if (input.resumeSessionId === undefined) return { ok: false, output: undefined, error: "an interactive run needs a session to resume" };
    const settings = chatSettings({
      nodePath: process.execPath,
      binPath,
      configPath,
      workspacePath: input.workspacePath,
      artifactsDir: input.artifactsDir,
      cleanupPeriodDays: CLEANUP_PERIOD_DAYS,
      denyPaths: input.denyPaths,
    });
    const mcpServers = Object.fromEntries(Object.entries(input.mcpServers).map(([name, spec]) => [name, claudeMcpServer(spec)]));
    const run = ctx.factories?.spawnInteractive ?? spawnInteractive;
    const code = await run(claudeExecutable(), chatArgs({ sessionId: input.resumeSessionId, model: brain.model, settings, mcpServers }), { cwd: input.workspacePath, env: input.env });
    return code === 0 ? { ok: true, output: undefined, sessionId: input.resumeSessionId } : { ok: false, output: undefined, error: `claude exited with code ${code}`, sessionId: input.resumeSessionId };
  };

export const registerRunPod = (program: Command, ctx: CliContext): void => {
  program
    .command("run-pod")
    .description("run pod agent container: runs the spec's setup and brain against the pod's sidecars, then reports to the steward; holds no credential")
    .requiredOption("--spec <file>", "the run's spec (JSON)")
    .option("--overlay <dir>", "the rendered overlay (placeholders only) to copy into the worktree", POD_OVERLAY_DIR)
    .option("--egress-ca <file>", "the egress sidecar's CA certificate", EGRESS_CA_FILE)
    .option("--tools-url <url>", "the tools sidecar", TOOLS_URL)
    .option("--wait-for <ports>", "comma-separated loopback ports to wait for before the run", POD_WAIT_PORTS.join(","))
    .option("--wait-seconds <n>", "how long to wait for them and the CA", String(POD_WAIT_TIMEOUT_MS / 1000))
    .option("--checks-listen <address>", "127.0.0.1:<port> for the check endpoint", `${TOOLS_HOST}:${POD_PORTS.checks}`)
    .action(async (opts: RunPodOptions) => {
      let spec: RunSpec;
      let waitPorts: number[];
      let checksListen: { host: string; port: number };
      let waitTimeoutMs: number;
      try {
        spec = RunSpecSchema.parse(JSON.parse(await readFile(opts.spec, "utf8")));
        waitPorts = parsePorts(opts.waitFor);
        checksListen = parseListen(opts.checksListen, "the check endpoint");
        waitTimeoutMs = Number(opts.waitSeconds) * 1000;
        if (!Number.isFinite(waitTimeoutMs) || waitTimeoutMs <= 0) throw new Error(`--wait-seconds must be a positive number, got ${JSON.stringify(opts.waitSeconds)}`);
      } catch (err) {
        return fail(ctx, `run-pod: ${errorMessage(err)}`);
      }
      const callbackUrl = process.env[CALLBACK_URL_ENV];
      const runnerToken = process.env[RUNNER_TOKEN_ENV];
      if (callbackUrl === undefined || callbackUrl === "" || runnerToken === undefined || runnerToken === "") return fail(ctx, `run-pod: ${CALLBACK_URL_ENV} and ${RUNNER_TOKEN_ENV} must be set`);

      const { config, configPath } = await loadFromProgram(program, ctx, { withoutSecrets: true });
      if (config.brain.kind !== "claude-code") return fail(ctx, 'run-pod: a run pod runs the claude-code brain only; brain.kind is "openai-agents"');
      const injected = ctx.factories?.brain;
      const runBrain: typeof runBrainDetached | undefined = spec.interactive
        ? interactiveBrain(ctx, configPath)
        : injected === undefined
          ? undefined
          : (_brain, input) => injected.run(input, () => undefined);

      // A SIGTERM (the Job deleted, the pod evicted) stops the run, which still reports, as interrupted.
      const controller = new AbortController();
      const stop = (): void => controller.abort();
      process.on("SIGTERM", stop);
      try {
        const report = await runPod({
          spec,
          brain: config.brain,
          ...(config.implement?.commitAuthor === undefined ? {} : { author: config.implement.commitAuthor }),
          skillsDir: config.workspace.skillsDir,
          overlayDir: opts.overlay,
          caFile: opts.egressCa,
          toolsUrl: opts.toolsUrl,
          waitPorts,
          waitTimeoutMs,
          checksListen,
          checksTimeoutMs: ((config.implement?.checksTimeoutMinutes ?? 0) + 1) * MINUTE_MS,
          callbackUrl,
          runnerToken,
          fetchImpl: ctx.fetchImpl,
          warn: (message) => void ctx.stderr.write(`run-pod: ${message}\n`),
          signal: controller.signal,
          ...(runBrain === undefined ? {} : { runBrain }),
        });
        println(ctx, `run ${spec.runId} reported: ${report.ok ? "ok" : `failed: ${report.error ?? "no error given"}`}`);
      } catch (err) {
        return fail(ctx, `run-pod: ${errorMessage(err)}`);
      } finally {
        process.off("SIGTERM", stop);
      }
    });
};
