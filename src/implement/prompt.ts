import { renderPrompt } from "../core/prompt.js";

export interface ImplementPromptVars {
  identifier: string;
  teamKey: string;
  teamName: string;
  ticket: string;
  workspacePath: string;
  baseBranch: string;
  sha: string;
  artifactsDir: string;
  stewardPort: number;
  hasBrief: boolean;
  brief: string;
  /** Comma-separated implement.branchTypes: the choices for the push tool's `branchType` on the first push. */
  branchTypes: string;
  /** True when implement.checks is non-empty. */
  hasChecks: boolean;
  /** implement.checks with `{{baseSha}}` filled in, one per line as a Markdown list. */
  checks: string;
  /** A person's answer to the questions an earlier run asked (`{{#reply}}`); empty on a fresh implement. */
  reply: string;
}

/** Fill the implement prompt template, with the repo's own section (`readRepoPartial`) as `{{> repo}}`. */
export const renderImplementPrompt = (template: string, vars: ImplementPromptVars, repo = ""): string => renderPrompt(template, vars, repo);
