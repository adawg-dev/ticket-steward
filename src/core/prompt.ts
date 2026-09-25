import Mustache from "mustache";

const { render } = Mustache;

export interface PromptVars {
  ticket: string;
  templates: string;
  workspacePath: string;
  baseBranch: string;
  sha: string;
  artifactsDir: string;
  teamKey: string;
  teamName: string;
  stewardPort: number;
  /** Set for tickets filed through ticket-gateway (Slack intake); null otherwise. */
  gateway: { className: string; teamKey: string } | null;
  /** The ticket carries one of `tracker.bugLabels`, so the brain is asked to reproduce it. */
  isBug: boolean;
}

const verbatim = (value: string): string => value;

export const renderPrompt = (template: string, vars: PromptVars): string =>
  render(template, vars, undefined, { escape: verbatim });
