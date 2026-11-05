import { atRunLevel, validateImplementResult, type ImplementResult } from "../../src/implement/result.js";

const implemented: ImplementResult = {
  outcome: "implemented",
  summary: "Flush the buffer before closing.",
  reviewNotes: [],
  checksRun: ["pnpm turbo check-types: ok"],
  questions: [],
  failureDetail: null,
  media: [],
  level: null,
  design: null,
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

  it("reads a result without level or design as having neither", () => {
    const older: Partial<ImplementResult> = { ...implemented };
    delete older.level;
    delete older.design;
    expect(validateImplementResult(older)).toEqual({ ok: true, result: implemented });
  });

  it("accepts any level the agent reports: the steward stamps it with the run's level", () => {
    expect(validateImplementResult({ ...implemented, level: { started: "standard", finished: "small", reason: null } }).ok).toBe(true);
    expect(validateImplementResult({ ...implemented, level: { started: "small", finished: "design", reason: "needs a design" } }).ok).toBe(true);
  });
});

describe("atRunLevel", () => {
  it("starts the level where the steward started the run and never finishes it lower", () => {
    expect(atRunLevel({ ...implemented, level: { started: "design", finished: "small", reason: "smaller than it looked" } }, "standard").level).toEqual({ started: "standard", finished: "standard", reason: null });
  });

  it("keeps a step-up above the run's level, with its reason", () => {
    expect(atRunLevel({ ...implemented, level: { started: "small", finished: "design", reason: "a migration" } }, "standard").level).toEqual({ started: "standard", finished: "design", reason: "a migration" });
  });

  it("reads no level from the agent as the run's level, unchanged", () => {
    expect(atRunLevel(implemented, "small")).toEqual({ ...implemented, level: { started: "small", finished: "small", reason: null } });
  });
});
