import { describe, expect, it } from "vitest";
import { FixResultSchema, validateFixResult, type FixResult } from "../../src/greptile/result.js";
import type { Finding } from "../../src/greptile/summary.js";

const finding = (discussionId: string): Finding => ({ discussionId, body: "b", filePath: "a.ts", lineStart: 1, lineEnd: 1, suggestedCode: null });
const base = (over: Partial<FixResult>): FixResult => ({
  outcome: "changed",
  threads: [{ discussionId: "d1", action: "fixed", reply: "Fixed it." }],
  summary: "did it",
  checksRun: [],
  failureDetail: null,
  media: [],
  ...over,
});
const t = (discussionId: string, action: "fixed" | "declined" = "fixed", reply = "ok") => ({ discussionId, action, reply });

describe("validateFixResult", () => {
  const findings = [finding("d1"), finding("d2")];
  it("accepts a complete result", () => {
    expect(validateFixResult(base({ threads: [t("d1"), t("d2", "declined")] }), findings).ok).toBe(true);
  });
  it("accepts changed with zero threads when there are zero findings", () => {
    expect(validateFixResult(base({ threads: [] }), []).ok).toBe(true);
  });
  it("rejects a missing thread id", () => {
    expect(validateFixResult(base({ threads: [t("d1")] }), findings)).toMatchObject({ ok: false });
  });
  it("rejects an extra id", () => {
    expect(validateFixResult(base({ threads: [t("d1"), t("d2"), t("d3")] }), findings)).toMatchObject({ ok: false });
  });
  it("rejects a duplicate id", () => {
    expect(validateFixResult(base({ threads: [t("d1"), t("d1"), t("d2")] }), findings)).toMatchObject({ ok: false });
  });
  it("rejects an empty reply", () => {
    expect(validateFixResult(base({ threads: [t("d1", "fixed", "  "), t("d2")] }), findings)).toMatchObject({ ok: false });
  });
  it("rejects a reply mentioning @greptileai", () => {
    expect(validateFixResult(base({ threads: [t("d1", "fixed", "thanks @greptileai"), t("d2")] }), findings)).toMatchObject({ ok: false });
  });
  it("rejects no_changes with a fixed thread", () => {
    expect(validateFixResult(base({ outcome: "no_changes", threads: [t("d1"), t("d2", "declined")] }), findings)).toMatchObject({ ok: false });
  });
  it("accepts no_changes when every thread is declined", () => {
    expect(validateFixResult(base({ outcome: "no_changes", threads: [t("d1", "declined"), t("d2", "declined")] }), findings).ok).toBe(true);
  });
  it("accepts a result without a commit message: the agent wrote its own when it committed", () => {
    expect(validateFixResult(base({ threads: [t("d1"), t("d2")] }), findings).ok).toBe(true);
    expect(FixResultSchema.shape).not.toHaveProperty("commitMessage");
  });
  it("rejects failed without failureDetail and empty summary", () => {
    expect(validateFixResult(base({ outcome: "failed", threads: [t("d1"), t("d2")] }), findings)).toMatchObject({ ok: false });
    expect(validateFixResult(base({ summary: "", threads: [t("d1"), t("d2")] }), findings)).toMatchObject({ ok: false });
  });
  it("rejects non-object output", () => {
    expect(validateFixResult("x", findings)).toMatchObject({ ok: false });
  });
});
