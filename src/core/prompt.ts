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
  operatorInstructions: string;
}

const verbatim = (value: string): string => value;

export const renderPrompt = (template: string, vars: PromptVars): string =>
  render(template, vars, undefined, { escape: verbatim });
