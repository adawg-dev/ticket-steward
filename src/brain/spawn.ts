import { fork } from "node:child_process";
import { createWriteStream } from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { BrainConfig } from "../config/schema.js";
import type { Redactor } from "../core/redact.js";
import { logger } from "../log.js";
import type { RunnerControl, RunnerMessage, RunnerStart } from "./runner.js";
import { INTERRUPTED_ERROR, type BrainControlSink, type BrainInput, type BrainRun } from "./types.js";

const runningFromSource = import.meta.url.endsWith(".ts");
const runnerPath = fileURLToPath(new URL(runningFromSource ? "./runner.ts" : "./runner.js", import.meta.url));
const execArgv = runningFromSource ? ["--import", import.meta.resolve("tsx")] : [];

const killGroup = (pid: number): void => {
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    // group already gone
  }
};

export const runBrainDetached = async (
  brain: BrainConfig,
  input: BrainInput,
  redactor: Redactor,
  opts: { signal?: AbortSignal; control?: BrainControlSink } = {},
): Promise<BrainRun> => {
  await mkdir(dirname(input.transcriptPath), { recursive: true, mode: 0o700 });
  const transcript = createWriteStream(input.transcriptPath, { flags: "a", mode: 0o600 });
  transcript.on("error", (err) => logger.warn({ err, transcriptPath: input.transcriptPath }, "transcript write failed"));
  const child = fork(runnerPath, [], { detached: true, env: input.env, execArgv, stdio: ["ignore", "ignore", "ignore", "ipc"] });
  const pid = child.pid;

  const interrupt = (): void => {
    if (pid !== undefined) killGroup(pid);
  };
  let settled = false;
  /** Forwards a control message to the runner; dropped once the run settled or the channel closed. */
  const control = (message: RunnerControl): void => {
    if (settled || !child.connected) return;
    try {
      child.send(message);
    } catch (err) {
      logger.warn({ err }, "brain control message not delivered");
    }
  };
  const run = await new Promise<BrainRun>((resolve) => {
    const timer = setTimeout(() => resolve({ ok: false, output: undefined, error: `brain timed out after ${input.timeoutMs} ms` }), input.timeoutMs);
    const settle = (result: BrainRun): void => {
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    child.on("message", (raw: unknown) => {
      const message = raw as RunnerMessage;
      if (message.type === "line" && !transcript.destroyed) transcript.write(`${redactor.redact(message.line)}\n`);
      if (message.type === "done") settle(message.run);
    });
    child.on("error", (err) => settle({ ok: false, output: undefined, error: err.message }));
    child.on("exit", (code, signal) => {
      if (opts.signal?.aborted) settle({ ok: false, output: undefined, error: INTERRUPTED_ERROR });
      else settle({ ok: false, output: undefined, error: `runner exited before finishing (code ${code}, signal ${signal})` });
    });
    opts.signal?.addEventListener("abort", interrupt, { once: true });
    if (opts.signal?.aborted) interrupt();
    const start: RunnerStart = { type: "start", brain, input };
    child.send(start);
    opts.control?.({ steer: (message) => control({ type: "steer", message }), stop: () => control({ type: "stop" }) });
  });

  opts.signal?.removeEventListener("abort", interrupt);
  if (pid !== undefined) killGroup(pid);
  child.removeAllListeners("message");
  await new Promise<void>((resolve) => {
    transcript.once("error", () => resolve());
    transcript.end(resolve);
  });
  return run;
};
