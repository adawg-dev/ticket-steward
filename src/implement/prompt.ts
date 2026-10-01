import Mustache from "mustache";

const { render } = Mustache;

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
  /** Comma-separated implement.branchTypes. */
  branchTypes: string;
  /** True when implement.checks is non-empty. */
  hasChecks: boolean;
  /** implement.checks with `{{baseSha}}` filled in, one per line as a Markdown list. */
  checks: string;
}

const verbatim = (value: string): string => value;

export const renderImplementPrompt = (template: string, vars: ImplementPromptVars): string => render(template, vars, undefined, { escape: verbatim });
