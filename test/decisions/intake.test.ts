import { createHash } from "node:crypto";
import type { DecisionsClient, ModelAnswer, Question } from "../../src/decisions/client.js";
import { askIntake, decisionsKey, INTAKE_QUESTIONS } from "../../src/decisions/intake.js";
import { Redactor } from "../../src/core/redact.js";
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

interface Asked {
  input: string;
  questions: Question[];
  models: string[];
}

/** A client that records what it was asked and answers every model with a predicate. */
const recordingClient = (models = ["jev-latest", "clef"]) => {
  const asked: Asked[] = [];
  const client: DecisionsClient = {
    models,
    ask: async (input, questions, subset = models) => {
      asked.push({ input, questions, models: subset });
      return subset.map((requested): ModelAnswer => ({
        model: requested, requested, answers: [{ type: "predicate", name: "ready", probability: 0.9 }], latencyMs: 5, cost: null, error: null,
      }));
    },
  };
  return { asked, client };
};

const settings = (enabled: boolean) => ({ get: () => ({ ...DEFAULT_SETTINGS, "decisions.enabled": enabled }) });
const at = { jobId: 1, issueId: "issue-1" };
const redactor = new Redactor(["SECRET-VALUE-123"]);

interface Row {
  requested: string;
  point: string;
  subject: string | null;
  loop_id: number | null;
  input_chars: number;
  input_sha256: string;
}
const rows = (): Row[] => stores.db.prepare<[], Row>("SELECT requested, point, subject, loop_id, input_chars, input_sha256 FROM decisions ORDER BY id").all();

describe("INTAKE_QUESTIONS", () => {
  it("asks `ready` as a predicate and `workflow` as small, standard or design", () => {
    expect(INTAKE_QUESTIONS.map((q) => [q.name, q.type])).toEqual([["ready", "predicate"], ["workflow", "choice"]]);
    const workflow = INTAKE_QUESTIONS[1];
    expect(workflow?.type === "choice" ? workflow.choices.map((c) => c.value) : []).toEqual(["small", "standard", "design"]);
  });
});

describe("decisionsKey", () => {
  it("prefers CONCENTRATE_API_KEY, then ANTHROPIC_AUTH_TOKEN, then ANTHROPIC_API_KEY", () => {
    expect(decisionsKey({ CONCENTRATE_API_KEY: "c", ANTHROPIC_AUTH_TOKEN: "t", ANTHROPIC_API_KEY: "k" })).toBe("c");
    expect(decisionsKey({ ANTHROPIC_AUTH_TOKEN: "t", ANTHROPIC_API_KEY: "k" })).toBe("t");
    expect(decisionsKey({ ANTHROPIC_API_KEY: "k" })).toBe("k");
    expect(decisionsKey({ CONCENTRATE_API_KEY: "" })).toBeNull();
    expect(decisionsKey({})).toBeNull();
  });
});

describe("askIntake", () => {
  it("records one intake row per model with the hash of what it sent, redacted", async () => {
    const { asked, client } = recordingClient();
    await askIntake({ decisions: client, stores, settings: settings(true), redactor }, at, "# Ticket\nuses SECRET-VALUE-123");
    expect(asked).toHaveLength(1);
    const sent = asked[0]?.input ?? "";
    expect(sent).not.toContain("SECRET-VALUE-123");
    expect(asked[0]?.questions).toBe(INTAKE_QUESTIONS);
    const sha = createHash("sha256").update(sent).digest("hex");
    expect(rows()).toEqual([
      { requested: "jev-latest", point: "intake", subject: null, loop_id: null, input_chars: sent.length, input_sha256: sha },
      { requested: "clef", point: "intake", subject: null, loop_id: null, input_chars: sent.length, input_sha256: sha },
    ]);
  });

  it("asks only the models not yet recorded for the job", async () => {
    const { asked, client } = recordingClient();
    await askIntake({ decisions: client, stores, settings: settings(true), redactor }, at, "t");
    const second = recordingClient(["jev-latest", "clef", "mercury-decide"]);
    await askIntake({ decisions: second.client, stores, settings: settings(true), redactor }, at, "t");
    expect(asked[0]?.models).toEqual(["jev-latest", "clef"]);
    expect(second.asked.map((a) => a.models)).toEqual([["mercury-decide"]]);
    const third = recordingClient(["jev-latest"]);
    await askIntake({ decisions: third.client, stores, settings: settings(true), redactor }, at, "t");
    expect(third.asked).toEqual([]);
  });

  it("does nothing without a client or with decisions.enabled off", async () => {
    await askIntake({ stores, settings: settings(true), redactor }, at, "t");
    const { asked, client } = recordingClient();
    await askIntake({ decisions: client, stores, settings: settings(false), redactor }, at, "t");
    expect(asked).toEqual([]);
    expect(rows()).toEqual([]);
  });

  it("swallows a client that throws", async () => {
    const client: DecisionsClient = { models: ["jev-latest"], ask: () => Promise.reject(new Error("boom")) };
    await expect(askIntake({ decisions: client, stores, settings: settings(true), redactor }, at, "t")).resolves.toBeUndefined();
    expect(rows()).toEqual([]);
  });
});
