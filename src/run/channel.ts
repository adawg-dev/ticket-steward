import type { BrainControl, BrainControlSink } from "../brain/types.js";
import { logger } from "../log.js";

/** What a person sends a running brain: a message it takes between turns, or a stop. */
export type RunCommand = { type: "steer"; message: string } | { type: "stop" };

/** The longest a steering poll waits for a command (the run pod's long-poll asks for this). */
export const MAX_STEER_WAIT_MS = 25_000;

interface Channel {
  issueId: string | null;
  onLine: (line: string) => void;
  queue: RunCommand[];
  /** False once the brain ended: its lines may still arrive, but no steer or stop can reach it any more. */
  steerable: boolean;
  /** The one `next` waiting for a command; a newer `next` answers it empty. */
  waiter: { resolve: (commands: RunCommand[]) => void; timer: NodeJS.Timeout } | null;
}

/**
 * The dispatcher's side of every open run: the brain's (redacted) message lines go out to the run's `onLine`, and steer
 * and stop commands queue until the executor takes them (`next`). The local executor drains it into the detached runner;
 * a run pod reaches it through the internal run API. Commands for a run that is not open are refused, not queued; a
 * stop for a job whose run has not opened yet is held for it (`stopWhenOpened`).
 */
export class RunChannels {
  private readonly channels = new Map<string, Channel>();
  /** Jobs stopped before their run opened a channel (queued, or claimed and still preparing): their run opens stopped. */
  private readonly pendingStops = new Set<number>();

  /**
   * Opens the run's channel; `issueId` lets `active` find it. Reopening keeps nothing of an earlier channel. A stop held
   * for `jobId` is queued at once, so the brain stops as soon as it starts.
   */
  open(runId: string, onLine: (line: string) => void, issueId: string | null = null, jobId: number | null = null): void {
    this.close(runId);
    const stopped = jobId !== null && this.pendingStops.delete(jobId);
    this.channels.set(runId, { issueId, onLine, queue: stopped ? [{ type: "stop" }] : [], steerable: true, waiter: null });
  }

  /** Holds a stop for the job until its run opens; a job that ends without opening a run never takes it. */
  stopWhenOpened(jobId: number): void {
    this.pendingStops.add(jobId);
  }

  /** Ends the run's channel: a waiting `next` answers empty, and queued commands are dropped. */
  close(runId: string): void {
    const channel = this.channels.get(runId);
    if (channel === undefined) return;
    this.channels.delete(runId);
    this.answer(channel, []);
  }

  /**
   * The run's brain ended (its result is in, or the run failed): from now on `steer` and `stop` are refused, so a caller
   * falls back to what it does without an open run (a chat after it, a review round) instead of a message nobody reads.
   * Commands still queued are dropped (logged); the channel stays open for the run's last lines until `close`.
   */
  endSteering(runId: string): void {
    const channel = this.channels.get(runId);
    if (channel === undefined || !channel.steerable) return;
    channel.steerable = false;
    const dropped = channel.queue.splice(0);
    if (dropped.length > 0) logger.warn({ runId, dropped: dropped.length }, "commands for a run whose brain had ended were dropped");
    this.answer(channel, []);
  }

  steer(runId: string, message: string): boolean {
    return this.push(runId, { type: "steer", message });
  }

  stop(runId: string): boolean {
    return this.push(runId, { type: "stop" });
  }

  /**
   * The run's queued commands, at once when there are any; otherwise the first that arrive within `waitMs`, or none.
   * Empty for a run that is not open. An aborted `signal` answers empty and leaves the queue as it is (the poller left).
   */
  next(runId: string, waitMs: number, signal?: AbortSignal): Promise<RunCommand[]> {
    const channel = this.channels.get(runId);
    if (channel === undefined || signal?.aborted === true) return Promise.resolve([]);
    if (channel.queue.length > 0) return Promise.resolve(channel.queue.splice(0));
    this.answer(channel, []);
    return new Promise((resolve) => {
      const timer = setTimeout(() => this.answer(channel, []), Math.max(0, waitMs));
      const waiter = {
        resolve: (commands: RunCommand[]) => {
          signal?.removeEventListener("abort", onAbort);
          resolve(commands);
        },
        timer,
      };
      const onAbort = (): void => {
        if (channel.waiter !== waiter) return;
        clearTimeout(timer);
        channel.waiter = null;
        waiter.resolve([]);
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      channel.waiter = waiter;
    });
  }

  /** One brain message line of the run, to its `onLine`; dropped when the run is not open. */
  line(runId: string, line: string): void {
    const channel = this.channels.get(runId);
    if (channel === undefined) return;
    try {
      channel.onLine(line);
    } catch (err) {
      logger.warn({ runId, err: err instanceof Error ? err.message : String(err) }, "a run's brain line could not be handled");
    }
  }

  /** The run id of the issue's open run, or null. */
  active(issueId: string): string | null {
    for (const [runId, channel] of this.channels) {
      if (channel.issueId === issueId) return runId;
    }
    return null;
  }

  private push(runId: string, command: RunCommand): boolean {
    const channel = this.channels.get(runId);
    if (channel === undefined || !channel.steerable) return false;
    channel.queue.push(command);
    if (channel.waiter !== null) this.answer(channel, channel.queue.splice(0));
    return true;
  }

  /** Answers the waiting `next`, if any, with `commands`. */
  private answer(channel: Channel, commands: RunCommand[]): void {
    const { waiter } = channel;
    if (waiter === null) return;
    channel.waiter = null;
    clearTimeout(waiter.timer);
    waiter.resolve(commands);
  }
}

/** Hands each command to the brain's handlers. */
export const applyCommands = (handlers: BrainControl, commands: RunCommand[]): void => {
  for (const command of commands) {
    if (command.type === "steer") handlers.steer(command.message);
    else handlers.stop();
  }
};

/**
 * The control sink of a run on this host: once the brain runs, the run's commands are taken from its channel and handed
 * to the brain until `end` (commands sent before the brain started wait in the channel). `end` leaves any left queued.
 */
export const drainChannel = (channels: Pick<RunChannels, "next">, runId: string): { control: BrainControlSink; end: () => void } => {
  const ended = new AbortController();
  const control: BrainControlSink = (handlers) => {
    const drain = async (): Promise<void> => {
      while (!ended.signal.aborted) applyCommands(handlers, await channels.next(runId, MAX_STEER_WAIT_MS, ended.signal));
    };
    drain().catch((err: unknown) => logger.warn({ runId, err: err instanceof Error ? err.message : String(err) }, "the run's steering stopped"));
  };
  return { control, end: () => ended.abort() };
};
