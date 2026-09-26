import Mustache from "mustache";

const { render } = Mustache;

export interface ReviewPromptVars {
  identifier: string;
  mrIid: number;
  mrTitle: string;
  mrUrl: string;
  mrDescription: string;
  sourceBranch: string;
  targetBranch: string;
  baseSha: string;
  headSha: string;
  diffPath: string;
  workspacePath: string;
  artifactsDir: string;
  stewardPort: number;
  ticket: string;
  hasRecipe: boolean;
  recipe: string;
  recipeSha: string;
  maxComments: number;
}

const verbatim = (value: string): string => value;

/** The MR description is untrusted author text inside a ~~~ fence; it must not be able to close the fence. */
const fenceSafe = (text: string): string => text.replaceAll("~~~", "~ ~ ~");

export const renderReviewPrompt = (template: string, vars: ReviewPromptVars): string =>
  render(template, { ...vars, mrDescription: fenceSafe(vars.mrDescription), mrTitle: fenceSafe(vars.mrTitle) }, undefined, { escape: verbatim });
