import { spawn } from "node:child_process";
import { STOPPED_ERROR, type Brain, type BrainKind, type BrainRun } from "./types.js";

export const FAKE_BRAIN_KIND = "fake";

/** Second transcript line of the fake brain: the runner's pid and the pid of a `sleep` it spawned, for process-group tests. */
export interface FakeBrainPids {
  type: "fake-pids";
  runnerPid: number;
  sleepPid: number | undefined;
}

export const createFakeBrain = (): Brain => ({
  kind: FAKE_BRAIN_KIND as unknown as BrainKind,
  run: async (input, onMessage, control) => {
    onMessage(JSON.stringify({ type: "fake", prompt: input.prompt }));
    if (input.prompt.includes("crash")) process.exit(3);
    const sleeper = spawn("sleep", ["100"], { stdio: "ignore" });
    const pids: FakeBrainPids = { type: "fake-pids", runnerPid: process.pid, sleepPid: sleeper.pid };
    onMessage(JSON.stringify(pids));
    if (input.prompt.includes("hang")) return new Promise(() => undefined);
    // Waits for the first control message: a steer returns its message, a stop the stopped error.
    if (input.prompt.includes("await steering")) {
      return new Promise<BrainRun>((resolve) => {
        control?.({
          steer: (message) => resolve({ ok: true, output: { steered: message } }),
          stop: () => resolve({ ok: false, output: undefined, error: STOPPED_ERROR }),
        });
      });
    }
    return { ok: true, output: { sleepPid: sleeper.pid } };
  },
});
