import { validateImplementResult, type ImplementResult } from "../../src/implement/result.js";

const implemented: ImplementResult = {
  outcome: "implemented",
  summary: "Flush the buffer before closing.",
  reviewNotes: [],
  checksRun: ["pnpm turbo check-types: ok"],
  questions: [],
  failureDetail: null,
  media: [],
};

describe("validateImplementResult", () => {
  it("accepts a complete implemented result", () => {
    expect(validateImplementResult(implemented)).toEqual({ ok: true, result: implemented });
  });

  it("drops the commit fields an older prompt still returns: the agent commits and pushes itself", () => {
    expect(validateImplementResult({ ...implemented, branchType: "hotfix", commitMessage: "" })).toEqual({ ok: true, result: implemented });
  });

  it("reads a result without media as showing none", () => {
    const older: Partial<ImplementResult> = { ...implemented };
    delete older.media;
    expect(validateImplementResult(older)).toEqual({ ok: true, result: { ...implemented, media: [] } });
    expect(validateImplementResult({ ...implemented, media: [{ path: "after.png", caption: "After" }] })).toMatchObject({ ok: true, result: { media: [{ path: "after.png", caption: "After" }] } });
  });

  it("requires questions for needs_info", () => {
    expect(validateImplementResult({ ...implemented, outcome: "needs_info", questions: [] }).ok).toBe(false);
    expect(validateImplementResult({ ...implemented, outcome: "needs_info", questions: ["Which page?"] }).ok).toBe(true);
  });

  it("requires failureDetail for failed", () => {
    expect(validateImplementResult({ ...implemented, outcome: "failed" }).ok).toBe(false);
    expect(validateImplementResult({ ...implemented, outcome: "failed", failureDetail: "tests fail" }).ok).toBe(true);
  });

  it("rejects an empty summary", () => {
    expect(validateImplementResult({ ...implemented, summary: "" }).ok).toBe(false);
  });
});
