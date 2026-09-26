import { normalizeReviewResult, validateReviewResult, type ReviewResult } from "../../src/review/result.js";

const result: ReviewResult = {
  verdict: "fixed",
  rerun: { observed: "the final chunk arrives", deviations: null },
  summary: "The fix works.",
  comments: [{ path: "src/adapter.ts", line: 3, side: "new", severity: "minor", body: "Name this constant." }],
  confidence: "high",
};

describe("validateReviewResult", () => {
  it("accepts a well-formed result", () => {
    expect(validateReviewResult(result)).toEqual({ ok: true, result });
  });

  it("rejects an empty summary, a non-positive line and an empty comment", () => {
    expect(validateReviewResult({ ...result, summary: " " })).toEqual({ ok: false, error: "summary is empty" });
    expect(validateReviewResult({ ...result, comments: [{ ...result.comments[0], line: 0 }] })).toEqual({ ok: false, error: "comment 0 has an invalid line" });
    expect(validateReviewResult({ ...result, comments: [{ ...result.comments[0], body: "" }] })).toEqual({ ok: false, error: "comment 0 is empty" });
  });

  it("rejects missing keys", () => {
    expect(validateReviewResult({ ...result, rerun: undefined }).ok).toBe(false);
  });
});

describe("normalizeReviewResult", () => {
  it("forces not_applicable without a recipe", () => {
    expect(normalizeReviewResult(result, false)).toEqual({ ...result, verdict: "not_applicable", rerun: null });
  });

  it("turns not_applicable into could_not_run when there was a recipe", () => {
    expect(normalizeReviewResult({ ...result, verdict: "not_applicable" }, true).verdict).toBe("could_not_run");
    expect(normalizeReviewResult(result, true)).toEqual(result);
  });

  it("downgrades a verdict with no replay to could_not_run when there was a recipe", () => {
    expect(normalizeReviewResult({ ...result, rerun: null }, true).verdict).toBe("could_not_run");
    expect(normalizeReviewResult({ ...result, verdict: "not_fixed", rerun: null }, true).verdict).toBe("could_not_run");
  });
});
