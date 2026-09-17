import { spawn } from "node:child_process";
import type { Brain, BrainKind } from "./types.js";

export const FAKE_BRAIN_KIND = "fake";

/** Second transcript line of the fake brain: the runner's pid and the pid of a `sleep` it spawned, for process-group tests. */
export interface FakeBrainPids {
  type: "fake-pids";
  runnerPid: number;
  sleepPid: number | undefined;
}

export const createFakeBrain = (): Brain => ({
  kind: FAKE_BRAIN_KIND as unknown as BrainKind,
  run: async (input, onMessage) => {
    onMessage(JSON.stringify({ type: "fake", prompt: input.prompt }));
    if (input.prompt.includes("crash")) process.exit(3);
    const sleeper = spawn("sleep", ["100"], { stdio: "ignore" });
    const pids: FakeBrainPids = { type: "fake-pids", runnerPid: process.pid, sleepPid: sleeper.pid };
    onMessage(JSON.stringify(pids));
    if (input.prompt.includes("hang")) return new Promise(() => undefined);
    return { ok: true, output: { sleepPid: sleeper.pid } };
  },
});
