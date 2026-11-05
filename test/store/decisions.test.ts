import type { ModelAnswer } from "../../src/decisions/client.js";
import type { NewDecision } from "../../src/store/decisions.js";
import { openStores, type Stores } from "../../src/store/index.js";
import { freshDataDir } from "./helpers.js";

let dataDir: string;
let stores: Stores;

beforeEach(() => {
  dataDir = freshDataDir();
  stores = openStores(dataDir);
});

afterEach(() => {
  stores.db.close();
});

const answer = (requested: string, patch: Partial<ModelAnswer> = {}): ModelAnswer => ({
  model: requested === "jev-latest" ? "jev-1.13.0" : requested,
  requested,
  answers: [{ type: "choice", name: "action", value: "fix", confidence: 0.7 }],
  latencyMs: 120,
  cost: 0.0001,
  error: null,
  ...patch,
});

const row = (patch: Partial<NewDecision> = {}): NewDecision => ({
  jobId: 1,
  issueId: "issue-1",
  loopId: 7,
  round: 2,
  point: "fix_item",
  subject: "d1",
  inputChars: 42,
  inputSha256: "ab".repeat(32),
  answer: answer("jev-latest"),
  ...patch,
});

interface Stored {
  job_id: number;
  point: string;
  subject: string | null;
  requested: string;
  model: string;
  answers: string | null;
  error: string | null;
  outcome: string | null;
}

const rows = (): Stored[] => stores.db.prepare<[], Stored>("SELECT * FROM decisions ORDER BY id").all();

describe("DecisionStore", () => {
  it("records a row per model answer, answers as JSON", () => {
    stores.decisions.record(row());
    stores.decisions.record(row({ answer: answer("clef", { answers: null, error: "timeout" }) }));
    const stored = rows();
    expect(stored.map((r) => [r.requested, r.model, r.error])).toEqual([
      ["jev-latest", "jev-1.13.0", null],
      ["clef", "clef", "timeout"],
    ]);
    expect(JSON.parse(stored[0]?.answers ?? "null")).toEqual([{ type: "choice", name: "action", value: "fix", confidence: 0.7 }]);
    expect(stored[1]?.answers).toBeNull();
  });

  it("has() finds an earlier row for the same job, point, subject and requested model", () => {
    stores.decisions.record(row());
    expect(stores.decisions.has(1, "fix_item", "d1", "jev-latest")).toBe(true);
    expect(stores.decisions.has(1, "fix_item", "d1", "clef")).toBe(false);
    expect(stores.decisions.has(1, "fix_item", "d2", "jev-latest")).toBe(false);
    expect(stores.decisions.has(2, "fix_item", "d1", "jev-latest")).toBe(false);
  });

  it("has() matches a null subject for intake rows", () => {
    stores.decisions.record(row({ point: "intake", subject: null, loopId: null, round: null }));
    expect(stores.decisions.has(1, "intake", null, "jev-latest")).toBe(true);
  });

  it("setOutcome fills only the given job's rows at that point and subject", () => {
    stores.decisions.record(row());
    stores.decisions.record(row({ subject: "d2" }));
    stores.decisions.record(row({ jobId: 2 }));
    stores.decisions.setOutcome(1, "fix_item", "fixed", "d1");
    expect(rows().map((r) => [r.job_id, r.subject, r.outcome])).toEqual([
      [1, "d1", "fixed"],
      [1, "d2", null],
      [2, "d1", null],
    ]);
  });

  it("setOutcome without a subject fills every row of the job at that point", () => {
    stores.decisions.record(row({ point: "intake", subject: null }));
    stores.decisions.record(row({ point: "intake", subject: null, answer: answer("clef") }));
    stores.decisions.setOutcome(1, "intake", "needs_info");
    expect(rows().map((r) => r.outcome)).toEqual(["needs_info", "needs_info"]);
  });

  it("a database created before the table gets it on open", () => {
    stores.db.exec("DROP TABLE decisions");
    stores.db.close();
    stores = openStores(dataDir);
    stores.decisions.record(row());
    expect(rows()).toHaveLength(1);
  });
});
