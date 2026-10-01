import { brainResultJsonSchema, validateResult } from "../../src/core/result.js";

const valid = {
  template: { matched: "Bugs", conforms: false, missing: ["Repro Steps"] },
  summary: "The handler drops the status code.",
  enrichment: "Look at `src/handler.ts:12`.",
  attachments: [],
  confidence: "high",
  repro: null,
  triage: { state: "ready-for-human", questions: [], agentBrief: "Goal: keep the last chunk." },
};

describe("validateResult", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("accepts a well-formed result", () => {
    expect(validateResult(valid)).toEqual({ ok: true, result: valid });
  });

  it("rejects an empty summary", () => {
    expect(validateResult({ ...valid, summary: "" }).ok).toBe(false);
  });

  it("rejects an empty enrichment", () => {
    expect(validateResult({ ...valid, enrichment: "   " }).ok).toBe(false);
  });

  it("rejects a result without the attachments field", () => {
    const withoutAttachments = {
      template: valid.template,
      summary: valid.summary,
      enrichment: valid.enrichment,
      confidence: valid.confidence,
    };
    expect(validateResult(withoutAttachments).ok).toBe(false);
  });

  it("rejects non-object output", () => {
    expect(validateResult("not json").ok).toBe(false);
  });
});

describe("brainResultJsonSchema", () => {
  it("requires all seven top-level keys", () => {
    expect(brainResultJsonSchema.required).toEqual([
      "template",
      "summary",
      "enrichment",
      "attachments",
      "confidence",
      "repro",
      "triage",
    ]);
  });

  it("carries no length constraints", () => {
    expect(JSON.stringify(brainResultJsonSchema)).not.toContain("minLength");
    expect(JSON.stringify(brainResultJsonSchema)).not.toContain("maxLength");
  });
});

const base = {
  template: { matched: null, conforms: true, missing: [] },
  summary: "s",
  enrichment: "e",
  attachments: [],
  confidence: "high",
  triage: { state: "ready-for-human", questions: [], agentBrief: "Goal: keep the last chunk." },
};

const repro = {
  status: "reproduced",
  method: "test",
  command: "pnpm --filter api vitest run test/repro-api-1.test.ts",
  steps: ["Run the focused test"],
  files: ["apps/api/test/repro-api-1.test.ts"],
  expected: "The final chunk is delivered",
  observed: "The stream ends one chunk early",
};

describe("validateResult repro", () => {
  it("accepts a null repro and a full recipe", () => {
    expect(validateResult({ ...base, repro: null }).ok).toBe(true);
    expect(validateResult({ ...base, repro }).ok).toBe(true);
  });

  it("requires the repro key", () => {
    expect(validateResult(base).ok).toBe(false);
  });

  it("requires a command unless the method is browser", () => {
    expect(validateResult({ ...base, repro: { ...repro, command: null } })).toEqual({ ok: false, error: "repro.command is required unless repro.method is browser" });
    expect(validateResult({ ...base, repro: { ...repro, method: "browser", command: null } }).ok).toBe(true);
  });

  it("requires steps for a browser recipe", () => {
    expect(validateResult({ ...base, repro: { ...repro, method: "browser", command: null, steps: [] } })).toEqual({ ok: false, error: "repro.steps is empty" });
  });
});

describe("triage validation", () => {
  it("requires questions for needs-info", () => {
    expect(validateResult({ ...valid, triage: { state: "needs-info", questions: [], agentBrief: null } })).toEqual({ ok: false, error: "triage needs-info without questions" });
  });

  it("requires an agent brief for ready-for-human", () => {
    expect(validateResult({ ...valid, triage: { state: "ready-for-human", questions: [], agentBrief: null } })).toEqual({ ok: false, error: "triage ready-for-human without an agentBrief" });
  });

  it("rejects a result without triage", () => {
    const rest: Record<string, unknown> = { ...valid };
    delete rest.triage;
    expect(validateResult(rest).ok).toBe(false);
  });
});
