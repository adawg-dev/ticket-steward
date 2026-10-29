import { renderPrompt } from "../core/prompt.js";
import type { CiFailure } from "./ci.js";
import type { WorkItem } from "./evaluate.js";

export interface FixPromptInput {
  identifier: string;
  round: number;
  /** Greptile's confidence on the head; null when Greptile is off. */
  score: number | null;
  /** The Greptile summary, verbatim; null when Greptile is off. */
  summary: string | null;
  /** The round's work list: every discussion waiting for an answer. */
  comments: WorkItem[];
  ciFailures: CiFailure[];
  /** The person's commits on the branch since the last round, one line each. */
  personCommits: string[];
  /** The loop's decisions: lasting instructions people gave about the MR, never to be undone. */
  decisions: string[];
  workspacePath: string;
  headSha: string;
  stewardPort: number;
  artifactsDir: string;
  /** implement.checks as a Markdown list. */
  checks: string;
  hasChecks: boolean;
}

const SUGGESTION_RE = /```suggestion[^\n]*\n([\s\S]*?)```/;

const location = (item: WorkItem): string => {
  const path = item.position?.newPath ?? item.position?.oldPath ?? null;
  if (path === null) return "a general comment";
  const line = item.position?.newLine ?? item.position?.oldLine ?? null;
  return line === null ? path : `${path}:${line}`;
};

/** Fill the fix prompt template (mustache, unescaped, like the implement prompt), with the repo's own section as `{{> repo}}`. */
export const renderFixPrompt = (template: string, input: FixPromptInput, repo = ""): string =>
  renderPrompt(
    template,
    {
      ...input,
      comments: input.comments.map((item) => {
        const suggestedCode = SUGGESTION_RE.exec(item.body)?.[1] ?? null;
        return { ...item, location: location(item), kind: item.isBot ? "bot" : "person", suggestedCode, hasSuggestion: suggestedCode !== null };
      }),
      hasComments: input.comments.length > 0,
      hasSummary: input.summary !== null,
      hasCiFailures: input.ciFailures.length > 0,
      hasPersonCommits: input.personCommits.length > 0,
      hasDecisions: input.decisions.length > 0,
    },
    repo,
  );
