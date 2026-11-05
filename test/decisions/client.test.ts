import { createDecisionsClient, mapLimit, type Question } from "../../src/decisions/client.js";

const QUESTIONS: Question[] = [{ type: "predicate", name: "ready", instructions: "Ready?" }];

interface Call {
  url: string;
  headers: Record<string, string>;
  body: { model: string; input: string; questions: Question[] };
}

/** A fetch that records each call and answers with `respond(model)`. */
const stubFetch = (respond: (model: string, signal: AbortSignal | undefined) => Promise<Response>) => {
  const calls: Call[] = [];
  const fetchImpl: typeof fetch = async (url, init) => {
    const body: Call["body"] = JSON.parse(String(init?.body));
    calls.push({ url: String(url), headers: Object.fromEntries(new Headers(init?.headers).entries()), body });
    return respond(body.model, init?.signal ?? undefined);
  };
  return { calls, fetchImpl };
};

const json = (value: unknown, status = 200): Response => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });

const ok = (model: string) =>
  json({ id: "d1", model: model === "jev-latest" ? "jev-1.13.0" : model, answers: [{ type: "predicate", name: "ready", probability: 0.8 }], cost: { total: 0.0001 } });

const client = (fetchImpl: typeof fetch, models = ["jev-latest"], extra: { timeoutMs?: number; redact?: (t: string) => string } = {}) =>
  createDecisionsClient({ baseUrl: "https://x/v1", models, apiKey: "k", redact: extra.redact ?? ((t) => t), fetchImpl, ...(extra.timeoutMs === undefined ? {} : { timeoutMs: extra.timeoutMs }) });

describe("decisions client", () => {
  it("posts one request per model to {baseUrl}/decisions with the bearer key", async () => {
    const { calls, fetchImpl } = stubFetch(async (model) => ok(model));
    const answers = await client(fetchImpl, ["jev-latest", "clef"]).ask("the ticket", QUESTIONS);
    expect(answers).toHaveLength(2);
    expect(calls.map((c) => c.url)).toEqual(["https://x/v1/decisions", "https://x/v1/decisions"]);
    expect(calls.map((c) => c.headers.authorization)).toEqual(["Bearer k", "Bearer k"]);
    expect(calls.map((c) => c.body.model).sort()).toEqual(["clef", "jev-latest"]);
    expect(calls[0]?.body).toMatchObject({ input: "the ticket", questions: QUESTIONS });
  });

  it("names its models and asks only the subset it is given", async () => {
    const { calls, fetchImpl } = stubFetch(async (model) => ok(model));
    const decisions = client(fetchImpl, ["jev-latest", "clef", "mercury-decide"]);
    expect(decisions.models).toEqual(["jev-latest", "clef", "mercury-decide"]);
    const answers = await decisions.ask("t", QUESTIONS, ["clef"]);
    expect(answers.map((a) => a.requested)).toEqual(["clef"]);
    expect(calls.map((c) => c.body.model)).toEqual(["clef"]);
  });

  it("redacts and truncates the input", async () => {
    const { calls, fetchImpl } = stubFetch(async (model) => ok(model));
    const redact = (t: string): string => t.replaceAll("SECRET123456", "***");
    await client(fetchImpl, ["jev-latest"], { redact }).ask(`token SECRET123456 ${"a".repeat(200_000)}`, QUESTIONS);
    const sent = calls[0]?.body.input ?? "";
    expect(sent).not.toContain("SECRET123456");
    expect(sent).toHaveLength(100_000);
  });

  it("returns the answers, the versioned model and the cost", async () => {
    const { fetchImpl } = stubFetch(async (model) => ok(model));
    const [answer] = await client(fetchImpl).ask("t", QUESTIONS);
    expect(answer).toMatchObject({
      model: "jev-1.13.0",
      requested: "jev-latest",
      answers: [{ type: "predicate", name: "ready", probability: 0.8 }],
      cost: 0.0001,
      error: null,
    });
    expect(answer?.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it("records http errors without throwing", async () => {
    const { fetchImpl } = stubFetch(async () => json({ error: "slow down" }, 429));
    const [answer] = await client(fetchImpl).ask("t", QUESTIONS);
    expect(answer).toMatchObject({ requested: "jev-latest", model: "jev-latest", answers: null, error: "http 429" });
  });

  it("records a refusal answer as an error", async () => {
    const { fetchImpl } = stubFetch(async () => json({ id: "d", model: "jev-1.13.0", answers: [{ type: "refusal", name: "ready" }] }));
    const [answer] = await client(fetchImpl).ask("t", QUESTIONS);
    expect(answer).toMatchObject({ answers: null, error: "refusal" });
  });

  it("treats a response missing an asked question's answer as invalid, in any order", async () => {
    const two: Question[] = [...QUESTIONS, { type: "predicate", name: "other", instructions: "Other?" }];
    const missing = stubFetch(async () => json({ id: "d", model: "jev-1.13.0", answers: [{ type: "predicate", name: "ready", probability: 0.4 }] }));
    expect((await client(missing.fetchImpl).ask("t", two))[0]).toMatchObject({ answers: null, error: "invalid response" });
    const empty = stubFetch(async () => json({ id: "d", model: "jev-1.13.0", answers: [] }));
    expect((await client(empty.fetchImpl).ask("t", QUESTIONS))[0]).toMatchObject({ answers: null, error: "invalid response" });
    const reordered = stubFetch(async () =>
      json({ id: "d", model: "jev-1.13.0", answers: [{ type: "predicate", name: "other", probability: 0.1 }, { type: "predicate", name: "ready", probability: 0.9 }] }),
    );
    expect((await client(reordered.fetchImpl).ask("t", two))[0]).toMatchObject({ error: null });
  });

  it("records an invalid body", async () => {
    const { fetchImpl } = stubFetch(async () => json({ nope: 1 }));
    const [answer] = await client(fetchImpl).ask("t", QUESTIONS);
    expect(answer).toMatchObject({ answers: null, error: "invalid response" });
  });

  it("records a network failure", async () => {
    const fetchImpl: typeof fetch = async () => {
      throw new Error("ECONNREFUSED");
    };
    const [answer] = await client(fetchImpl).ask("t", QUESTIONS);
    expect(answer).toMatchObject({ answers: null, error: "ECONNREFUSED" });
  });

  it("times out", async () => {
    const { fetchImpl } = stubFetch(
      (_model, signal) =>
        new Promise<Response>((_resolve, reject) => {
          signal?.addEventListener("abort", () => reject(signal.reason));
        }),
    );
    const [answer] = await client(fetchImpl, ["jev-latest"], { timeoutMs: 20 }).ask("t", QUESTIONS);
    expect(answer).toMatchObject({ answers: null, error: "timeout" });
  });
});

describe("mapLimit", () => {
  it("never runs more than the limit at once and keeps the order", async () => {
    let running = 0;
    let peak = 0;
    const results = await mapLimit([...Array(10).keys()], 3, async (n) => {
      running += 1;
      peak = Math.max(peak, running);
      await new Promise((resolve) => setTimeout(resolve, 5));
      running -= 1;
      return n * 2;
    });
    expect(peak).toBeLessThanOrEqual(3);
    expect(peak).toBeGreaterThan(1);
    expect(results).toEqual([0, 2, 4, 6, 8, 10, 12, 14, 16, 18]);
  });
});
