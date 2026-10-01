import { validateImplementResult, type ImplementResult } from "../../src/implement/result.js";

const TYPES = ["feature", "fix", "chore", "refactor"];
const implemented: ImplementResult = {
  outcome: "implemented",
  branchType: "fix",
  commitMessage: "Keep the last chunk\n\nThe adapter dropped it.",
  summary: "Flush the buffer before closing.",
  reviewNotes: [],
  checksRun: ["pnpm turbo check-types: ok"],
  questions: [],
  failureDetail: null,
};

describe("validateImplementResult", () => {
  it("accepts a complete implemented result", () => {
    expect(validateImplementResult(implemented, TYPES)).toEqual({ ok: true, result: implemented });
  });

  it("rejects a branch type outside the configured list", () => {
    const result = validateImplementResult({ ...implemented, branchType: "hotfix" }, TYPES);
    expect(result).toEqual({ ok: false, error: 'branchType "hotfix" is not one of feature, fix, chore, refactor' });
  });

  it("rejects implemented without a commit message", () => {
    expect(validateImplementResult({ ...implemented, commitMessage: " " }, TYPES).ok).toBe(false);
  });

  it("requires questions for needs_info", () => {
    expect(validateImplementResult({ ...implemented, outcome: "needs_info", branchType: null, questions: [] }, TYPES).ok).toBe(false);
    expect(validateImplementResult({ ...implemented, outcome: "needs_info", branchType: null, questions: ["Which page?"] }, TYPES).ok).toBe(true);
  });

  it("requires failureDetail for failed", () => {
    expect(validateImplementResult({ ...implemented, outcome: "failed", branchType: null }, TYPES).ok).toBe(false);
    expect(validateImplementResult({ ...implemented, outcome: "failed", branchType: null, failureDetail: "tests fail" }, TYPES).ok).toBe(true);
  });

  it("rejects an empty summary", () => {
    expect(validateImplementResult({ ...implemented, summary: "" }, TYPES).ok).toBe(false);
  });
});
