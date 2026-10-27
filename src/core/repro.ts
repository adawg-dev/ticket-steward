import type { BrainResult, Repro } from "./result.js";

export const isBugTicket = (labels: string[], bugLabels: string[]): boolean => {
  const wanted = new Set(bugLabels.map((label) => label.trim().toLowerCase()));
  return labels.some((label) => wanted.has(label.trim().toLowerCase()));
};

/** Only bug tickets carry a reproduction (spec §2.4), whatever the brain returned. */
export const normalizeRepro = (result: BrainResult, isBug: boolean): BrainResult =>
  isBug || result.repro === null ? result : { ...result, repro: null };

const shellFence = (command: string): string => {
  const fence = command.includes("```") ? "~~~" : "```";
  return `${fence}sh\n${command}\n${fence}`;
};

export const renderReproMarkdown = (repro: Repro): string => {
  const lines = ["### Reproduction", "", `**Status:** ${repro.status === "reproduced" ? "reproduced" : "not reproduced"} · **Method:** ${repro.method}`];
  if (repro.command !== null) lines.push("", "**Command** (from the workspace root):", "", shellFence(repro.command));
  if (repro.steps.length > 0) lines.push("", "**Steps:**", "", ...repro.steps.map((step, index) => `${index + 1}. ${step}`));
  lines.push("", `**Expected:** ${repro.expected}`, "", `**Observed:** ${repro.observed}`);
  if (repro.files.length > 0) lines.push("", `**Recipe files:** ${repro.files.map((file) => `\`${file}\``).join(", ")}`);
  return lines.join("\n");
};
