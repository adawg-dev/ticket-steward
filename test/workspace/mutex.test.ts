import { Mutex } from "../../src/workspace/mutex.js";

describe("Mutex", () => {
  it("runs sections one at a time in call order, and a failure does not block the next", async () => {
    const mutex = new Mutex();
    const events: string[] = [];
    let release: () => void = () => undefined;
    const first = mutex.run(async () => {
      events.push("first start");
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      events.push("first end");
    });
    const second = mutex.run(async () => {
      events.push("second");
      throw new Error("Intended Test Error");
    });
    const third = mutex.run(async () => {
      events.push("third");
      return 3;
    });

    await vi.waitFor(() => expect(events).toEqual(["first start"]));
    release();
    await first;
    await expect(second).rejects.toThrow("Intended Test Error");
    expect(await third).toBe(3);
    expect(events).toEqual(["first start", "first end", "second", "third"]);
  });
});
