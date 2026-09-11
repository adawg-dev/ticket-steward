import { fork } from "node:child_process";
import { createWriteStream } from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { BrainConfig } from "../config/schema.js";
import type { Redactor } from "../core/redact.js";
import type { RunnerMessage, RunnerStart } from "./runner.js";
import type { BrainInput, BrainRun } from "./types.js";

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

export const runBrainDetached = async (brain: BrainConfig, input: BrainInput, redactor: Redactor): Promise<BrainRun> => {
  await mkdir(dirname(input.transcriptPath), { recursive: true, mode: 0o700 });
  const transcript = createWriteStream(input.transcriptPath, { flags: "a", mode: 0o600 });
  const child = fork(runnerPath, [], { detached: true, env: input.env, execArgv, stdio: ["ignore", "ignore", "ignore", "ipc"] });
  const pid = child.pid;

  const run = await new Promise<BrainRun>((resolve) => {
    const timer = setTimeout(() => resolve({ ok: false, output: undefined, error: `brain timed out after ${input.timeoutMs} ms` }), input.timeoutMs);
    const settle = (result: BrainRun): void => {
      clearTimeout(timer);
      resolve(result);
    };
    child.on("message", (raw: unknown) => {
      const message = raw as RunnerMessage;
      if (message.type === "line") transcript.write(`${redactor.redact(message.line)}\n`);
      else settle(message.run);
    });
    child.on("error", (err) => settle({ ok: false, output: undefined, error: err.message }));
    child.on("exit", (code, signal) => settle({ ok: false, output: undefined, error: `runner exited before finishing (code ${code}, signal ${signal})` }));
    const start: RunnerStart = { type: "start", brain, input };
    child.send(start);
  });

  if (pid !== undefined) killGroup(pid);
  child.removeAllListeners("message");
  await new Promise<void>((resolve) => transcript.end(resolve));
  return run;
};
