import type { HelperResult, SlotPorts, SlotRunner } from "../../src/workspace/slots.js";

/** The real helper's port formula, for fakes only; the steward itself never computes it. */
export const helperPorts = (n: number): SlotPorts => ({ postgres: 15032 + 100 * n, redis: 16079 + 100 * n, rabbitmq: 17072 + 100 * n });

export interface FakeSlotRunner {
  run: SlotRunner;
  /** Every helper request's arguments, in order. */
  calls: string[][];
  /** The timeout each request was given, in order. */
  timeouts: number[];
  /** Every later request for `command` answers `result`; fields left out mean success. */
  respond: (command: string, result: Partial<HelperResult>) => void;
  /** Every later request for `command` waits until its signal aborts, then answers canceled. */
  hang: (command: string) => void;
}

const success = (stdout = ""): HelperResult => ({ exitCode: 0, stdout, output: stdout, timedOut: false, canceled: false });

/** A helper that succeeds at everything: `ports` prints `portsFor(n)` as JSON and `check` prints ok. */
export const fakeSlotRunner = (portsFor: (n: number) => SlotPorts = helperPorts): FakeSlotRunner => {
  const calls: string[][] = [];
  const timeouts: number[] = [];
  const responses = new Map<string, Partial<HelperResult>>();
  const hanging = new Set<string>();
  const run: SlotRunner = async (args, opts) => {
    calls.push(args);
    timeouts.push(opts.timeoutMs);
    const [command = "", n = "0"] = args;
    if (hanging.has(command)) {
      await new Promise<void>((resolve) => {
        if (opts.signal?.aborted === true) resolve();
        opts.signal?.addEventListener("abort", () => resolve(), { once: true });
      });
      return { ...success(), exitCode: 1, canceled: true };
    }
    const response = responses.get(command);
    if (response !== undefined) return { ...success(), ...response };
    if (command === "ports") return success(`${JSON.stringify(portsFor(Number(n)))}\n`);
    return success(command === "check" ? "ok\n" : "");
  };
  return {
    run,
    calls,
    timeouts,
    respond: (command, result) => {
      responses.set(command, result);
    },
    hang: (command) => {
      hanging.add(command);
    },
  };
};
