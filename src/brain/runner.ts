import type { BrainConfig } from "../config/schema.js";
import { createBrain } from "./index.js";
import type { BrainControl, BrainInput, BrainRun } from "./types.js";

export type RunnerStart = { type: "start"; brain: BrainConfig; input: BrainInput };
/** Parent → runner after the start: steer or stop the running brain. */
export type RunnerControl = { type: "steer"; message: string } | { type: "stop" };
export type RunnerMessage = { type: "line"; line: string } | { type: "done"; run: BrainRun };

const send = (message: RunnerMessage, onSent?: () => void): void => {
  process.send?.(message, undefined, undefined, onSent);
};

/** Control messages that arrive before the brain hands over its handlers wait here. */
let handlers: BrainControl | null = null;
const pending: RunnerControl[] = [];

const apply = (command: RunnerControl, to: BrainControl): void => {
  if (command.type === "steer") to.steer(command.message);
  else to.stop();
};

const start = (message: RunnerStart): void => {
  const brain = createBrain(message.brain);
  brain
    .run(
      message.input,
      (line) => send({ type: "line", line }),
      (control) => {
        handlers = control;
        for (const command of pending.splice(0)) apply(command, control);
      },
    )
    .then((run) => send({ type: "done", run }, () => process.exit(0)))
    .catch((err: unknown) => {
      const error = err instanceof Error ? err.message : String(err);
      send({ type: "done", run: { ok: false, output: undefined, error } }, () => process.exit(0));
    });
};

let started = false;
process.on("message", (raw: unknown) => {
  const message = raw as RunnerStart | RunnerControl;
  if (message.type === "start") {
    if (!started) start(message);
    started = true;
    return;
  }
  if (handlers === null) pending.push(message);
  else apply(message, handlers);
});
