import type { BrainResult } from "./result.js";

export const isBugTicket = (labels: string[], bugLabels: string[]): boolean => {
  const wanted = new Set(bugLabels.map((label) => label.trim().toLowerCase()));
  return labels.some((label) => wanted.has(label.trim().toLowerCase()));
};

/** Only bug tickets carry a reproduction (spec §2.4), whatever the brain returned. */
export const normalizeRepro = (result: BrainResult, isBug: boolean): BrainResult =>
  isBug || result.repro === null ? result : { ...result, repro: null };
