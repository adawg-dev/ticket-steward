import { BRIEF_BEGIN, BRIEF_END } from "../core/render.js";

/** The agent brief triage wrote into the Enrichment section, or null when the ticket went straight to ready-for-agent. */
export const extractAgentBrief = (description: string): string | null => {
  const begin = description.indexOf(BRIEF_BEGIN);
  const end = description.indexOf(BRIEF_END, begin);
  if (begin === -1 || end === -1) return null;
  const brief = description.slice(begin + BRIEF_BEGIN.length, end).trim();
  return brief === "" ? null : brief;
};
