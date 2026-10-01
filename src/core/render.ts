import { gatewayFooterStart } from "./gateway.js";
import { STEWARD_BEGIN, STEWARD_END } from "./intake.js";
import { renderReproMarkdown } from "./repro.js";
import type { BrainResult } from "./result.js";

export interface SectionMeta {
  now: Date;
  sha: string;
  branch: string;
  jobId: number;
  permalink: (path: string, line?: number) => string;
}

const SUMMARY_MAX = 600;
const FENCE = /(```[\s\S]*?```|~~~[\s\S]*?~~~)/;
const INLINE_CODE = /`([^`\n]+)`/g;
const FILE_REF = /^(?:[\w.@+-]+\/)*[\w@+-][\w.@+-]*\.[A-Za-z][A-Za-z0-9]*(?::(\d+))?$/;

export const truncate = (s: string, max: number): string => (s.length <= max ? s : `${s.slice(0, max - 1)}…`);

export const linkify = (markdown: string, permalink: SectionMeta["permalink"]): string =>
  markdown
    .split(FENCE)
    .map((segment, index) =>
      index % 2 === 1
        ? segment
        : segment.replace(INLINE_CODE, (whole, code: string) => {
            const match = FILE_REF.exec(code);
            if (match === null) return whole;
            const line = match[1] === undefined ? undefined : Number(match[1]);
            const path = match[1] === undefined ? code : code.slice(0, -(match[1].length + 1));
            return `[${code}](${permalink(path, line)})`;
          }),
    )
    .join("");

const templateLine = (template: BrainResult["template"]): string => {
  if (template.matched === null) return "**Template:** none matched";
  if (template.conforms) return `**Template:** ${template.matched} — conforms`;
  return `**Template:** ${template.matched} — missing: ${template.missing.join(", ")}`;
};

export const BRIEF_BEGIN = "<!-- ticket-steward:brief:begin -->";
export const BRIEF_END = "<!-- ticket-steward:brief:end -->";

const briefBlock = (triage: BrainResult["triage"], permalink: SectionMeta["permalink"]): string =>
  triage.state === "ready-for-human" && triage.agentBrief !== null
    ? ["### Agent brief", BRIEF_BEGIN, linkify(triage.agentBrief.trim(), permalink), BRIEF_END].join("\n")
    : "";

export const buildEnrichmentSection = (
  result: BrainResult,
  uploaded: Array<{ url: string; caption: string }>,
  notes: string[],
  meta: SectionMeta,
): string => {
  const stamp = meta.now.toISOString().slice(0, 16).replace("T", " ");
  const header = `_Ticket Steward · ${stamp} UTC · ${meta.branch}@${meta.sha.slice(0, 7)} · confidence: ${result.confidence} · job ${meta.jobId}_`;
  const blocks = [
    templateLine(result.template),
    linkify(result.enrichment.trim(), meta.permalink),
    briefBlock(result.triage, meta.permalink),
    result.repro === null ? "" : renderReproMarkdown(result.repro),
    uploaded.map(({ url, caption }) => `![${caption}](${url})`).join("\n"),
    notes.map((note) => `_Note: ${note}_`).join("\n"),
  ].filter((block) => block !== "");
  return [STEWARD_BEGIN, "## Enrichment", header, "", blocks.join("\n\n"), STEWARD_END].join("\n");
};

export const replaceSection = (description: string, section: string): string => {
  const begin = description.indexOf(STEWARD_BEGIN);
  const end = description.indexOf(STEWARD_END, begin);
  if (begin !== -1 && end !== -1) return `${description.slice(0, begin)}${section}${description.slice(end + STEWARD_END.length)}`;
  if (description === "") return section;
  const footer = gatewayFooterStart(description);
  if (footer === null) return `${description}\n\n${section}`;
  return `${description.slice(0, footer).trimEnd()}\n\n${section}\n\n${description.slice(footer)}`;
};

export const buildTriageComment = (result: BrainResult, jobId: number): string => {
  const head = `Triage (job ${jobId}, confidence ${result.confidence}): `;
  if (result.triage.state === "needs-info") {
    const questions = result.triage.questions.filter((q) => q.trim() !== "").map((q, index) => `${index + 1}. ${q.trim()}`);
    return [`${head}this ticket needs more information before it can be built.`, "", ...questions].join("\n");
  }
  return `${head}ready to build; the agent brief is in the Enrichment section. ${truncate(result.summary, SUMMARY_MAX)}`;
};
