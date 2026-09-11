import type { BrainConfig } from "../config/schema.js";
import { createBrain } from "./index.js";
import type { BrainInput, BrainRun } from "./types.js";

export type RunnerStart = { type: "start"; brain: BrainConfig; input: BrainInput };
export type RunnerMessage = { type: "line"; line: string } | { type: "done"; run: BrainRun };

const send = (message: RunnerMessage, onSent?: () => void): void => {
  process.send?.(message, undefined, undefined, onSent);
};

process.once("message", (raw: unknown) => {
  const start = raw as RunnerStart;
  const brain = createBrain(start.brain);
  brain
    .run(start.input, (line) => send({ type: "line", line }))
    .then((run) => send({ type: "done", run }, () => process.exit(0)))
    .catch((err: unknown) => {
      const error = err instanceof Error ? err.message : String(err);
      send({ type: "done", run: { ok: false, output: undefined, error } }, () => process.exit(0));
    });
});
