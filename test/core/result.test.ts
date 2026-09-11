import { brainResultJsonSchema, validateResult } from "../../src/core/result.js";

const valid = {
  template: { matched: "Bugs", conforms: false, missing: ["Repro Steps"] },
  summary: "The handler drops the status code.",
  enrichment: "Look at `src/handler.ts:12`.",
  attachments: [],
  confidence: "high",
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
  it("requires all five top-level keys", () => {
    expect(brainResultJsonSchema.required).toEqual([
      "template",
      "summary",
      "enrichment",
      "attachments",
      "confidence",
    ]);
  });

  it("carries no length constraints", () => {
    expect(JSON.stringify(brainResultJsonSchema)).not.toContain("minLength");
    expect(JSON.stringify(brainResultJsonSchema)).not.toContain("maxLength");
  });
});
