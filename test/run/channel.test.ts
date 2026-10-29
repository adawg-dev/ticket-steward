import type { BrainControl } from "../../src/brain/types.js";
import { drainChannel, RunChannels } from "../../src/run/channel.js";

describe("RunChannels", () => {
  it("queues a steer sent before anyone asks, and hands it to the next `next` at once", async () => {
    const channels = new RunChannels();
    channels.open("7-1", () => undefined, "issue-1");

    expect(channels.steer("7-1", "use v2")).toBe(true);
    expect(channels.stop("7-1")).toBe(true);

    expect(await channels.next("7-1", 60_000)).toEqual([{ type: "steer", message: "use v2" }, { type: "stop" }]);
  });

  it("answers a waiting `next` as soon as a command arrives, and empty when the wait passes", async () => {
    const channels = new RunChannels();
    channels.open("7-1", () => undefined);
    const started = Date.now();

    const waiting = channels.next("7-1", 60_000);
    setTimeout(() => channels.steer("7-1", "stop touching the schema"), 10);

    expect(await waiting).toEqual([{ type: "steer", message: "stop touching the schema" }]);
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(await channels.next("7-1", 10)).toEqual([]);
  });

  it("refuses commands for a run that is not open or has closed, and answers a waiting `next` empty on close", async () => {
    const channels = new RunChannels();
    expect(channels.steer("7-1", "hello")).toBe(false);

    channels.open("7-1", () => undefined);
    const waiting = channels.next("7-1", 60_000);
    channels.close("7-1");

    expect(await waiting).toEqual([]);
    expect(channels.stop("7-1")).toBe(false);
    expect(await channels.next("7-1", 60_000)).toEqual([]);
  });

  it("keeps the commands for the next poll when the waiting poller left", async () => {
    const channels = new RunChannels();
    channels.open("7-1", () => undefined);
    const left = new AbortController();

    const waiting = channels.next("7-1", 60_000, left.signal);
    left.abort();
    expect(await waiting).toEqual([]);

    channels.steer("7-1", "use v2");
    expect(await channels.next("7-1", 60_000)).toEqual([{ type: "steer", message: "use v2" }]);
  });

  it("passes the run's lines to its listener, survives one that throws, and names the issue's open run", () => {
    const channels = new RunChannels();
    const lines: string[] = [];
    channels.open("7-1", (line) => lines.push(line), "issue-1");
    channels.open("8-1", () => {
      throw new Error("listener broke");
    }, "issue-2");

    channels.line("7-1", '{"type":"assistant"}');
    channels.line("8-1", '{"type":"assistant"}');
    channels.line("9-1", '{"type":"assistant"}');

    expect(lines).toEqual(['{"type":"assistant"}']);
    expect(channels.active("issue-1")).toBe("7-1");
    expect(channels.active("issue-3")).toBeNull();
    channels.close("7-1");
    expect(channels.active("issue-1")).toBeNull();
  });

  it("holds a stop for a job until its run opens, then queues it once, for that job only", async () => {
    const channels = new RunChannels();
    channels.stopWhenOpened(7);

    channels.open("8-1", () => undefined, "issue-2", 8);
    expect(await channels.next("8-1", 0)).toEqual([]);

    channels.open("7-1", () => undefined, "issue-1", 7);
    expect(await channels.next("7-1", 0)).toEqual([{ type: "stop" }]);

    channels.open("7-2", () => undefined, "issue-1", 7);
    expect(await channels.next("7-2", 0)).toEqual([]);
  });
});

describe("drainChannel", () => {
  it("hands commands queued before the brain started, and those that follow, to the brain until the run ends", async () => {
    const channels = new RunChannels();
    channels.open("7-1", () => undefined);
    const received: string[] = [];
    const handlers: BrainControl = { steer: (message) => received.push(`steer ${message}`), stop: () => received.push("stop") };
    const { control, end } = drainChannel(channels, "7-1");

    channels.steer("7-1", "use v2");
    control(handlers);
    await vi.waitFor(() => expect(received).toEqual(["steer use v2"]));
    channels.stop("7-1");
    await vi.waitFor(() => expect(received).toEqual(["steer use v2", "stop"]));

    end();
    await new Promise((resolve) => setTimeout(resolve, 10));
    channels.steer("7-1", "too late");
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(received).toEqual(["steer use v2", "stop"]);
  });
});
