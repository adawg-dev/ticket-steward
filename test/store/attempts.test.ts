import { openStores, type Stores } from "../../src/store/index.js";
import { createdEvent, freshDataDir } from "./helpers.js";

let stores: Stores;

beforeEach(() => {
  vi.restoreAllMocks();
  stores = openStores(freshDataDir());
});

afterEach(() => {
  stores.db.close();
});

describe("AttemptStore", () => {
  it("start numbers attempts per job and leaves them unfinished", () => {
    const jobId = stores.jobs.enqueue(createdEvent);
    const otherJobId = stores.jobs.enqueue(createdEvent);

    const first = stores.attempts.start(jobId);
    const second = stores.attempts.start(jobId);
    const other = stores.attempts.start(otherJobId);

    expect(first.jobId).toBe(jobId);
    expect(first.number).toBe(1);
    expect(second.number).toBe(2);
    expect(other.number).toBe(1);
    expect(typeof first.startedAt).toBe("string");
    expect(first.finishedAt).toBeNull();
    expect(first.error).toBeNull();
    expect(first.setupTail).toBeNull();
    expect(first.preWriteDescription).toBeNull();
    expect(first.transcriptPath).toBeNull();
    expect(first.usage).toBeNull();
  });

  it("finish records the patch and finishedAt, visible through forJob in order", () => {
    const jobId = stores.jobs.enqueue(createdEvent);
    const first = stores.attempts.start(jobId);
    const second = stores.attempts.start(jobId);

    stores.attempts.finish(second.id, {
      error: "brain timeout",
      setupTail: "pnpm install ok",
      preWriteDescription: "old description",
      transcriptPath: "/data/jobs/1/attempt-2.jsonl",
      usage: { inputTokens: 10, outputTokens: 5, costUsd: 0.01 },
    });

    const attempts = stores.attempts.forJob(jobId);
    expect(attempts.length).toBe(2);
    expect(attempts[0]?.id).toBe(first.id);
    expect(attempts[0]?.finishedAt).toBeNull();
    expect(attempts[1]?.id).toBe(second.id);
    expect(typeof attempts[1]?.finishedAt).toBe("string");
    expect(attempts[1]?.error).toBe("brain timeout");
    expect(attempts[1]?.setupTail).toBe("pnpm install ok");
    expect(attempts[1]?.preWriteDescription).toBe("old description");
    expect(attempts[1]?.transcriptPath).toBe("/data/jobs/1/attempt-2.jsonl");
    expect(attempts[1]?.usage).toEqual({ inputTokens: 10, outputTokens: 5, costUsd: 0.01 });
  });

  it("patch records details without closing the attempt", () => {
    const jobId = stores.jobs.enqueue(createdEvent);
    const attempt = stores.attempts.start(jobId);

    stores.attempts.patch(attempt.id, { transcriptPath: "/data/jobs/1/attempt-1.jsonl", setupTail: "pnpm install ok" });

    const [stored] = stores.attempts.forJob(jobId);
    expect(stored?.finishedAt).toBeNull();
    expect(stored?.transcriptPath).toBe("/data/jobs/1/attempt-1.jsonl");
    expect(stored?.setupTail).toBe("pnpm install ok");
  });

  it("finish with an empty patch only sets finishedAt", () => {
    const jobId = stores.jobs.enqueue(createdEvent);
    const attempt = stores.attempts.start(jobId);

    stores.attempts.finish(attempt.id, {});

    const [stored] = stores.attempts.forJob(jobId);
    expect(typeof stored?.finishedAt).toBe("string");
    expect(stored?.error).toBeNull();
    expect(stored?.usage).toBeNull();
    expect(stores.attempts.forJob(999)).toEqual([]);
  });
});
