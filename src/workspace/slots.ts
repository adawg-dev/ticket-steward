import { connect } from "node:net";
import { z } from "zod";
import { isSlotTemplate, SLOT_TEMPLATE_PATTERN, type SlotsConfig, type SlotTemplate } from "../config/schema.js";
import { logger } from "../log.js";
import { keepTail } from "./setup.js";

export interface SlotPorts {
  postgres: number;
  redis: number;
  rabbitmq: number;
}

/** One job's slot: its number, its app port and the host ports of its fresh containers. */
export interface Slot {
  n: number;
  appPort: number;
  ports: SlotPorts;
}

export interface HelperResult {
  exitCode: number;
  /** What the command printed; over the socket stdout and stderr arrive merged, so this equals `output`. */
  stdout: string;
  /** Everything the command printed, plus the runner's own reason when the request itself failed. */
  output: string;
  timedOut: boolean;
  canceled: boolean;
}

/** Runs one helper command; never throws, a failure is a non-zero `exitCode`. */
export type SlotRunner = (args: string[], opts: { timeoutMs: number; signal?: AbortSignal }) => Promise<HelperResult>;

const HELPER_TAIL_BYTES = 4 * 1024;
const MAX_REPLY_BYTES = 64 * 1024;
const HELPER_TIMEOUT_MS = 60_000;
const SECOND_MS = 1_000;
/** The helper's last line in socket mode. */
const EXIT_LINE = /(?:^|\n)exit (\d+)\n?$/;

const PortSchema = z.number().int().min(1).max(65_535);
const PortsSchema = z.object({ postgres: PortSchema, redis: PortSchema, rabbitmq: PortSchema });

/** A slot command failed; `tail` is the end of the helper's output, not yet redacted. */
export class SlotError extends Error {
  constructor(
    readonly n: number,
    readonly tail: string,
  ) {
    super(`slot ${n}: ${tail}`);
  }
}

/** Splits a socket reply into the command's output and the exit status it ends with; null when the status line is missing. */
const parseReply = (reply: string): { exitCode: number; body: string } | null => {
  const match = EXIT_LINE.exec(reply);
  if (match === null) return null;
  return { exitCode: Number(match[1]), body: reply.slice(0, match.index + (match[0].startsWith("\n") ? 1 : 0)) };
};

/**
 * One request over the helper's socket (systemd starts a root helper per connection): `<command> <n>\n` out, the
 * command's output and a last `exit <code>` line back. A timeout or an abort closes the connection.
 */
export const socketRunner =
  (socketPath: string): SlotRunner =>
  (args, opts) =>
    new Promise((resolve) => {
      let reply = "";
      let failure: string | null = null;
      let timedOut = false;
      let canceled = false;
      const socket = connect(socketPath);
      const timer = setTimeout(() => {
        timedOut = true;
        socket.destroy();
      }, opts.timeoutMs);
      const onAbort = (): void => {
        canceled = true;
        socket.destroy();
      };
      opts.signal?.addEventListener("abort", onAbort, { once: true });
      if (opts.signal?.aborted === true) onAbort();
      socket.setEncoding("utf8");
      socket.on("connect", () => socket.write(`${args.join(" ")}\n`));
      // setEncoding makes every chunk a string (split multi-byte characters are reassembled); the type still says Buffer.
      socket.on("data", (chunk: Buffer | string) => {
        reply = keepTail(reply + String(chunk), MAX_REPLY_BYTES);
      });
      socket.on("error", (err) => {
        failure = `cannot reach the slot helper at ${socketPath}: ${err.message}`;
      });
      socket.on("close", () => {
        clearTimeout(timer);
        opts.signal?.removeEventListener("abort", onAbort);
        const parsed = timedOut || canceled ? null : parseReply(reply);
        if (parsed !== null) {
          resolve({ exitCode: parsed.exitCode, stdout: parsed.body, output: parsed.body, timedOut, canceled });
          return;
        }
        // A timeout or abort is reported by its flag (the client adds the note); anything else gets its reason appended.
        const reason = timedOut || canceled ? "" : (failure ?? "helper closed without an exit status");
        const separator = reply === "" || reply.endsWith("\n") ? "" : "\n";
        resolve({ exitCode: 1, stdout: reply, output: reason === "" ? reply : `${reply}${separator}${reason}`, timedOut, canceled });
      });
    });

const parseJson = (text: string): unknown => {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
};

const failureTail = (result: HelperResult): string => {
  const output = result.output.trimEnd();
  const note = result.canceled ? "[interrupted]" : `[exit ${result.exitCode}]`;
  return keepTail(output === "" ? note : `${output}\n${note}`, HELPER_TAIL_BYTES);
};

/** Talks to the root slot helper; the only path from the steward to Docker. */
export class SlotClient {
  /** Slots this process brought up and has not released: only these need a `down` when their job ends. */
  private readonly started = new Set<number>();
  private readonly run: SlotRunner;

  constructor(
    private readonly settings: Pick<SlotsConfig, "socket" | "upTimeoutSeconds">,
    runner?: SlotRunner,
  ) {
    this.run = runner ?? socketRunner(settings.socket);
  }

  /** The slot's host ports as the helper reports them; the helper holds the only copy of the formula. */
  async ports(n: number): Promise<SlotPorts> {
    const result = await this.run(["ports", String(n)], { timeoutMs: HELPER_TIMEOUT_MS });
    if (result.exitCode !== 0) throw new SlotError(n, failureTail(result));
    const parsed = PortsSchema.safeParse(parseJson(result.stdout.trim()));
    if (!parsed.success) throw new SlotError(n, `ports printed no port JSON: ${keepTail(result.stdout.trim(), HELPER_TAIL_BYTES)}`);
    return parsed.data;
  }

  /** Clears whatever an earlier run left, starts fresh containers and returns their ports. */
  async start(n: number, signal?: AbortSignal): Promise<SlotPorts> {
    const cancel = signal === undefined ? {} : { signal };
    const down = await this.run(["down", String(n)], { timeoutMs: HELPER_TIMEOUT_MS, ...cancel });
    if (down.exitCode !== 0 || down.canceled) throw new SlotError(n, failureTail(down));
    this.started.add(n);
    const up = await this.run(["up", String(n)], { timeoutMs: this.settings.upTimeoutSeconds * SECOND_MS, ...cancel });
    if (up.timedOut) throw new SlotError(n, keepTail(`${up.output.trimEnd()}\n[timed out after ${this.settings.upTimeoutSeconds} s]`, HELPER_TAIL_BYTES));
    if (up.exitCode !== 0 || up.canceled) throw new SlotError(n, failureTail(up));
    return this.ports(n);
  }

  /** Brings down a slot this process started; the job's outcome stands whatever happens here. */
  async release(n: number): Promise<void> {
    if (!this.started.delete(n)) return;
    await this.down(n);
  }

  /** `down` whoever started the slot (startup and shutdown); a failure is logged, never thrown. */
  async down(n: number): Promise<boolean> {
    const result = await this.run(["down", String(n)], { timeoutMs: HELPER_TIMEOUT_MS });
    if (result.exitCode === 0) return true;
    logger.warn({ slot: n, tail: failureTail(result) }, "slot down failed");
    return false;
  }

  /** The slot's running containers, one line each; empty when the slot is down. */
  async status(n: number): Promise<string> {
    const result = await this.run(["status", String(n)], { timeoutMs: HELPER_TIMEOUT_MS });
    if (result.exitCode !== 0) throw new SlotError(n, failureTail(result));
    return result.stdout.trim();
  }

  /** The helper's own check (compose file parses, images pulled); over the socket it also proves the socket units work. */
  async check(): Promise<{ ok: boolean; output: string }> {
    const result = await this.run(["check"], { timeoutMs: HELPER_TIMEOUT_MS });
    const lastLine = result.stdout.trim().split("\n").at(-1);
    return { ok: result.exitCode === 0 && lastLine === "ok", output: keepTail(result.output.trim(), HELPER_TAIL_BYTES) };
  }
}

/** A job's slot as the pipelines see it: its number and the client that brings it up and down. */
export interface SlotRef {
  n: number;
  client: SlotClient;
}

/** `slots.env` with every `{{template}}` replaced by this slot's value; null (delete the key) stays null. */
export const renderSlotEnv = (env: Record<string, string | null>, slot: Slot): Record<string, string | null> => {
  const values: Record<SlotTemplate, number> = { app: slot.appPort, ...slot.ports };
  return Object.fromEntries(
    Object.entries(env).map(([key, value]): [string, string | null] => [
      key,
      value === null ? null : value.replace(SLOT_TEMPLATE_PATTERN, (match: string, name: string) => (isSlotTemplate(name) ? String(values[name]) : match)),
    ]),
  );
};
