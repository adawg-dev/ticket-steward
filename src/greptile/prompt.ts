import { renderPrompt } from "../core/prompt.js";
import type { CiFailure } from "./ci.js";
import type { Finding } from "./summary.js";

export interface FixPromptInput {
  identifier: string;
  round: number;
  maxRounds: number;
  score: number;
  /** The Greptile summary, verbatim. */
  summary: string;
  findings: Finding[];
  ciFailures: CiFailure[];
  /** The person's commits on the branch since the last round, one line each. */
  personCommits: string[];
  newComments: Array<{ author: string; body: string }>;
  workspacePath: string;
  headSha: string;
  stewardPort: number;
  artifactsDir: string;
  /** implement.checks as a Markdown list. */
  checks: string;
  hasChecks: boolean;
}

const location = (f: Finding): string => {
  if (f.filePath === null) return "no file";
  return f.lineStart === null ? f.filePath : `${f.filePath}:${f.lineStart}`;
};

/** Fill the fix prompt template (mustache, unescaped, like the implement prompt), with the repo's own section as `{{> repo}}`. */
export const renderFixPrompt = (template: string, input: FixPromptInput, repo = ""): string =>
  renderPrompt(
    template,
    {
      ...input,
      findings: input.findings.map((f) => ({ ...f, location: location(f), hasSuggestion: f.suggestedCode !== null })),
      hasFindings: input.findings.length > 0,
      hasCiFailures: input.ciFailures.length > 0,
      hasPersonCommits: input.personCommits.length > 0,
      hasNewComments: input.newComments.length > 0,
    },
    repo,
  );
