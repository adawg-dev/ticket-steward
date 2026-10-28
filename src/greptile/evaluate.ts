import type { MergeRequestInfo } from "../codehost/gitlabMr.js";
import type { GreptileConfig } from "../config/schema.js";
import type { Loop } from "../store/loops.js";
import { shaMatches, type Finding, type GreptileSummary } from "./summary.js";

export type GreptileStatus = "pending" | "completed" | "failed" | "skipped";
export type RoundDecision =
  /** `deadline`: when the wait's timeout runs out (null before its clock starts), so the next poll need not overrun it. */
  | { kind: "wait"; waitingFor: "mr" | "review" | "pipeline"; deadline: Date | null }
  | { kind: "passed"; summary: GreptileSummary }
  | { kind: "fix"; summary: GreptileSummary; findings: Finding[]; pipelineFailed: boolean }
  | { kind: "handback"; reason: string }
  | { kind: "stop"; reason: string; comment: boolean };
export interface RoundInput {
  loop: Loop; settings: GreptileConfig; now: Date; ticketClosed: boolean;
  mr: MergeRequestInfo | null; summary: GreptileSummary | null; findings: Finding[];
  /** Only known with the Greptile MCP. */
  greptileStatus: GreptileStatus | null;
}

const UNFINISHED_PIPELINE = new Set(["created", "pending", "running", "waiting_for_resource", "preparing"]);
const DEAD_PIPELINE = new Set(["canceled", "skipped", "manual"]);

/** Decide what the fix loop does next; every timeout counts from `loop.waitStartedAt`. */
export const evaluateRound = (input: RoundInput): RoundDecision => {
  const { loop, settings, now, mr, summary } = input;
  const timedOut = (minutes: number): boolean =>
    loop.waitStartedAt !== null && now.getTime() - Date.parse(loop.waitStartedAt) > minutes * 60_000;
  const deadline = (minutes: number): Date | null =>
    loop.waitStartedAt === null ? null : new Date(Date.parse(loop.waitStartedAt) + minutes * 60_000);

  if (input.ticketClosed) return { kind: "stop", reason: "the ticket was closed", comment: false };
  if (mr === null) {
    return timedOut(settings.mrTimeoutMinutes)
      ? { kind: "handback", reason: `no merge request was opened for ${loop.branch}` }
      : { kind: "wait", waitingFor: "mr", deadline: deadline(settings.mrTimeoutMinutes) };
  }
  if (mr.state === "merged" || mr.state === "closed") {
    return { kind: "stop", reason: `the merge request was ${mr.state}`, comment: true };
  }
  const short = mr.sha.slice(0, 7);
  if (mr.sha.toLowerCase() !== loop.headSha.toLowerCase()) {
    return { kind: "handback", reason: "a person pushed to the branch; the loop stopped" };
  }
  if (input.greptileStatus === "failed" || input.greptileStatus === "skipped") {
    return { kind: "handback", reason: `Greptile review ${input.greptileStatus} for ${short}` };
  }
  const reviewed = summary !== null
    && shaMatches(summary.lastReviewedSha, mr.sha)
    && (loop.reviewCountAtTrigger === null || (summary.reviewCount ?? -1) > loop.reviewCountAtTrigger);
  if (!reviewed || summary === null) {
    return timedOut(settings.reviewTimeoutMinutes)
      ? { kind: "handback", reason: `Greptile did not review ${short}` }
      : { kind: "wait", waitingFor: "review", deadline: deadline(settings.reviewTimeoutMinutes) };
  }
  const pipeline = mr.headPipeline !== null && mr.headPipeline.sha === mr.sha ? mr.headPipeline : null;
  if (pipeline === null || UNFINISHED_PIPELINE.has(pipeline.status)) {
    return timedOut(settings.pipelineTimeoutMinutes)
      ? { kind: "handback", reason: `no finished pipeline for ${short}` }
      : { kind: "wait", waitingFor: "pipeline", deadline: deadline(settings.pipelineTimeoutMinutes) };
  }
  if (DEAD_PIPELINE.has(pipeline.status)) {
    return { kind: "handback", reason: `the pipeline for ${short} is ${pipeline.status}` };
  }
  if (summary.score === 5 && input.findings.length === 0 && pipeline.status === "success") {
    return { kind: "passed", summary };
  }
  if (loop.round >= settings.maxRounds) {
    return {
      kind: "handback",
      reason: `Greptile scored ${summary.score}/5 after ${loop.round} fix rounds (pipeline ${pipeline.status})`,
    };
  }
  return { kind: "fix", summary, findings: input.findings, pipelineFailed: pipeline.status === "failed" };
};
