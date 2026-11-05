import type { DecisionsClient, ModelAnswer, Question } from "../../src/decisions/client.js";
import { askReview, itemInput, MAX_ITEMS, REVIEW_QUESTIONS } from "../../src/decisions/review.js";
import { Redactor } from "../../src/core/redact.js";
import type { WorkItem } from "../../src/greptile/evaluate.js";
import type { GreptileSummary } from "../../src/greptile/summary.js";
import { DEFAULT_SETTINGS } from "../../src/settings/schema.js";
import { openStores, type Stores } from "../../src/store/index.js";
import { freshDataDir } from "../store/helpers.js";

let stores: Stores;

beforeEach(() => {
  stores = openStores(freshDataDir());
});

afterEach(() => {
  stores.db.close();
});

const item = (discussionId: string, patch: Partial<WorkItem> = {}): WorkItem => ({
  discussionId,
  author: "greptile-bot",
  isBot: true,
  body: `Finding ${discussionId}: null check missing.`,
  position: { newPath: "src/adapter.ts", oldPath: "src/adapter.ts", newLine: 12, oldLine: null },
  ...patch,
});

const summary: GreptileSummary = {
  body: "Confidence Score: 3/5 — the adapter drops data.",
  score: 3,
  reviewCount: 2,
  lastReviewedSha: null,
  updatedAt: "2026-11-05T00:00:00.000Z",
  source: "note",
};

/** A client that answers after a tick, tracking how many requests overlap. */
const countingClient = () => {
  const state = { running: 0, peak: 0, inputs: [] as string[], questions: [] as Question[][] };
  const client: DecisionsClient = {
    models: ["jev-latest"],
    ask: async (input, questions, models = ["jev-latest"]) => {
      state.running += 1;
      state.peak = Math.max(state.peak, state.running);
      state.inputs.push(input);
      state.questions.push(questions);
      await new Promise((resolve) => setTimeout(resolve, 2));
      state.running -= 1;
      return models.map((requested): ModelAnswer => ({ model: requested, requested, answers: [{ type: "choice", name: "action", value: "fix" }], latencyMs: 2, cost: null, error: null }));
    },
  };
  return { client, state };
};

const deps = (client: DecisionsClient) => ({ decisions: client, stores, settings: { get: () => DEFAULT_SETTINGS }, redactor: new Redactor([]) });
const at = { jobId: 3, issueId: "issue-1", loopId: 7, round: 2 };
const subjects = (): Array<string | null> =>
  stores.db.prepare<[], { subject: string | null }>("SELECT subject FROM decisions WHERE point = 'fix_item' ORDER BY id").all().map((r) => r.subject);

describe("REVIEW_QUESTIONS", () => {
  it("asks `action` as fix, decline, nit or escalate", () => {
    const [action] = REVIEW_QUESTIONS;
    expect(action?.name).toBe("action");
    expect(action?.type === "choice" ? action.choices.map((c) => c.value) : []).toEqual(["fix", "decline", "nit", "escalate"]);
  });
});

describe("itemInput", () => {
  it("names a bot author, the file and line, the comment and Greptile's summary", () => {
    const input = itemInput(item("d1"), summary);
    expect(input).toContain("bot");
    expect(input).toContain("src/adapter.ts:12");
    expect(input).toContain("Finding d1: null check missing.");
    expect(input).toContain("Confidence Score: 3/5");
  });

  it("leaves Greptile's summary out of a person's comment, and the position out of a general one", () => {
    const input = itemInput(item("d2", { author: "ada", isBot: false, position: null, body: "Please rename this." }), summary);
    expect(input).toContain("person");
    expect(input).toContain("Please rename this.");
    expect(input).not.toContain("Confidence Score");
    expect(input).not.toContain("src/adapter.ts");
  });
});

describe("askReview", () => {
  it("asks once per item about that item, at most 8 at a time, and only the first 20", async () => {
    const { client, state } = countingClient();
    const work = Array.from({ length: 25 }, (_, n) => item(`d${n}`));
    await askReview(deps(client), at, work, summary);
    expect(MAX_ITEMS).toBe(20);
    expect(state.inputs).toHaveLength(20);
    expect(state.peak).toBeLessThanOrEqual(8);
    expect(state.peak).toBeGreaterThan(1);
    expect(state.questions.every((q) => q === REVIEW_QUESTIONS)).toBe(true);
    expect(subjects()).toHaveLength(20);
    expect(new Set(subjects())).toEqual(new Set(work.slice(0, 20).map((w) => w.discussionId)));
  });

  it("asks nothing for an empty work list", async () => {
    const { client, state } = countingClient();
    await askReview(deps(client), at, [], summary);
    expect(state.inputs).toEqual([]);
  });
});
