import { describe, expect, it } from "vitest";
import { evaluateRound, type RoundInput } from "../../src/greptile/evaluate.js";
import type { Finding, GreptileSummary } from "../../src/greptile/summary.js";
import type { Loop } from "../../src/store/loops.js";
import type { GreptileConfig } from "../../src/config/schema.js";
import { fakeMergeRequest } from "../fakes/fakeGitLabMr.js";

const SHA = "c".repeat(40);
const NOW = new Date("2026-10-27T12:00:00Z");
const minutesAgo = (m: number): string => new Date(NOW.getTime() - m * 60_000).toISOString();

const settings: GreptileConfig = {
  botUsername: "greptile-bot", maxRounds: 5, prompt: "p", pollSeconds: 60, mrTimeoutMinutes: 60,
  reviewTimeoutMinutes: 30, pipelineTimeoutMinutes: 60, ciLogLines: 200,
};
const loop = (over: Partial<Loop> = {}): Loop => ({
  id: 1, issueId: "i", identifier: "API-1", teamKey: "API", implementJobId: 1, branch: "api-1-fix", baseSha: "a".repeat(40),
  headSha: SHA, worktreeName: "w", labelDriven: false, projectId: 42, mrIid: 7, mrUrl: null, sessionId: null, round: 1,
  state: "awaiting_review", history: [], waitStartedAt: minutesAgo(1), reviewCountAtTrigger: null, adoptedFrom: null,
  pendingPush: null, handedBackAt: null, endedAt: null, createdAt: minutesAgo(100), ...over,
});
const summary = (over: Partial<GreptileSummary> = {}): GreptileSummary => ({
  body: "", score: 5, reviewCount: 2, lastReviewedSha: SHA.slice(0, 7), updatedAt: minutesAgo(1), source: "note", ...over,
});
const finding: Finding = { discussionId: "d1", body: "b", filePath: null, lineStart: null, lineEnd: null, suggestedCode: null };

const baseInput = (over: Partial<RoundInput> = {}): RoundInput => ({
  loop: loop(), settings, now: NOW, ticketClosed: false,
  mr: fakeMergeRequest({ sha: SHA, headPipeline: { id: 9, sha: SHA, status: "success" } }),
  summary: summary(), findings: [], greptileStatus: null, ...over,
});
const withPipeline = (status: string, sha = SHA) => fakeMergeRequest({ sha: SHA, headPipeline: { id: 9, sha, status } });

describe("evaluateRound", () => {
  it("passes the base input", () => {
    expect(evaluateRound(baseInput())).toMatchObject({ kind: "passed" });
  });
  it("1: stops silently when the ticket is closed", () => {
    expect(evaluateRound(baseInput({ ticketClosed: true }))).toEqual({ kind: "stop", reason: expect.any(String), note: false });
  });
  it("gives each wait the deadline of the timeout it is bounded by", () => {
    const started = new Date(NOW.getTime() - 5 * 60_000);
    const at = (minutes: number): Date => new Date(started.getTime() + minutes * 60_000);
    const waiting = (over: Partial<RoundInput>) => evaluateRound(baseInput({ loop: loop({ waitStartedAt: started.toISOString() }), ...over }));
    expect(waiting({ mr: null })).toEqual({ kind: "wait", waitingFor: "mr", deadline: at(60) });
    expect(waiting({ summary: null })).toEqual({ kind: "wait", waitingFor: "review", deadline: at(30) });
    expect(waiting({ mr: fakeMergeRequest({ sha: SHA }) })).toEqual({ kind: "wait", waitingFor: "pipeline", deadline: at(60) });
    expect(evaluateRound(baseInput({ mr: null, loop: loop({ waitStartedAt: null }) }))).toEqual({ kind: "wait", waitingFor: "mr", deadline: null });
  });
  it("2: waits for the MR, then hands back past the timeout", () => {
    const fresh = baseInput({ mr: null, loop: loop({ waitStartedAt: minutesAgo(5) }) });
    expect(evaluateRound(fresh)).toMatchObject({ kind: "wait", waitingFor: "mr" });
    const stale = baseInput({ mr: null, loop: loop({ waitStartedAt: minutesAgo(61) }) });
    expect(evaluateRound(stale)).toEqual({ kind: "handback", reason: "no merge request was opened for api-1-fix" });
  });
  it("3: stops with an MR note when the MR is merged or closed", () => {
    for (const state of ["merged", "closed"]) {
      const d = evaluateRound(baseInput({ mr: fakeMergeRequest({ sha: SHA, state }) }));
      expect(d).toMatchObject({ kind: "stop", note: true });
    }
  });
  it("4: hands back when a person pushed", () => {
    const d = evaluateRound(baseInput({ mr: fakeMergeRequest({ sha: "d".repeat(40) }) }));
    expect(d).toEqual({ kind: "handback", reason: "a person pushed to the branch; the loop stopped" });
  });
  it("5: hands back when Greptile failed or skipped", () => {
    for (const status of ["failed", "skipped"] as const) {
      expect(evaluateRound(baseInput({ greptileStatus: status }))).toEqual({ kind: "handback", reason: `Greptile review ${status} for ccccccc` });
    }
  });
  it("6: waits for the review, then hands back past the timeout", () => {
    expect(evaluateRound(baseInput({ summary: null }))).toMatchObject({ kind: "wait", waitingFor: "review" });
    expect(evaluateRound(baseInput({ summary: summary({ lastReviewedSha: "d".repeat(7) }) }))).toMatchObject({ kind: "wait", waitingFor: "review" });
    const stale = baseInput({ summary: null, loop: loop({ waitStartedAt: minutesAgo(31) }) });
    expect(evaluateRound(stale)).toEqual({ kind: "handback", reason: "Greptile did not review ccccccc" });
  });
  it("6: a review count equal to the count at trigger is not finished", () => {
    const input = baseInput({ loop: loop({ reviewCountAtTrigger: 2 }), summary: summary({ reviewCount: 2 }) });
    expect(evaluateRound(input)).toMatchObject({ kind: "wait", waitingFor: "review" });
    expect(evaluateRound({ ...input, summary: summary({ reviewCount: 3 }) })).toMatchObject({ kind: "passed" });
  });
  it("7: waits for an unfinished pipeline, then hands back past the timeout", () => {
    for (const status of ["created", "pending", "running", "waiting_for_resource", "preparing"]) {
      expect(evaluateRound(baseInput({ mr: withPipeline(status) }))).toMatchObject({ kind: "wait", waitingFor: "pipeline" });
    }
    expect(evaluateRound(baseInput({ mr: fakeMergeRequest({ sha: SHA }) }))).toMatchObject({ kind: "wait", waitingFor: "pipeline" });
    const stale = baseInput({ mr: withPipeline("running"), loop: loop({ waitStartedAt: minutesAgo(61) }) });
    expect(evaluateRound(stale)).toEqual({ kind: "handback", reason: "no finished pipeline for ccccccc" });
  });
  it("7: a pipeline for an older sha counts as no pipeline", () => {
    expect(evaluateRound(baseInput({ mr: withPipeline("success", "d".repeat(40)) }))).toMatchObject({ kind: "wait", waitingFor: "pipeline" });
  });
  it("7: hands back on canceled, skipped or manual pipelines", () => {
    for (const status of ["canceled", "skipped", "manual"]) {
      expect(evaluateRound(baseInput({ mr: withPipeline(status) }))).toEqual({ kind: "handback", reason: `the pipeline for ccccccc is ${status}` });
    }
  });
  it("8/10: a 4/5 with a green pipeline and no findings gets a fix", () => {
    const s = summary({ score: 4 });
    expect(evaluateRound(baseInput({ summary: s }))).toEqual({ kind: "fix", summary: s, findings: [], pipelineFailed: false });
  });
  it("8/10: findings get a fix even at 5/5", () => {
    expect(evaluateRound(baseInput({ findings: [finding] }))).toMatchObject({ kind: "fix", findings: [finding] });
  });
  it("10: a 5/5 with a failed pipeline gets a fix with pipelineFailed", () => {
    expect(evaluateRound(baseInput({ mr: withPipeline("failed") }))).toMatchObject({ kind: "fix", pipelineFailed: true });
  });
  it("9: hands back once maxRounds is reached", () => {
    const d = evaluateRound(baseInput({ summary: summary({ score: 4 }), loop: loop({ round: 5 }) }));
    expect(d).toEqual({ kind: "handback", reason: "Greptile scored 4/5 after 5 fix rounds (pipeline success)" });
  });
});
