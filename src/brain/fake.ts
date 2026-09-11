import { spawn } from "node:child_process";
import type { Brain, BrainKind } from "./types.js";

export const FAKE_BRAIN_KIND = "fake";

export const createFakeBrain = (): Brain => ({
  kind: FAKE_BRAIN_KIND as unknown as BrainKind,
  run: async (input, onMessage) => {
    onMessage(JSON.stringify({ type: "fake", prompt: input.prompt }));
    if (input.prompt.includes("hang")) return new Promise(() => undefined);
    const sleeper = spawn("sleep", ["100"], { stdio: "ignore" });
    return { ok: true, output: { sleepPid: sleeper.pid } };
  },
});
