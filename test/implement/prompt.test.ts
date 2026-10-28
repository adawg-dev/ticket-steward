import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { renderImplementPrompt, type ImplementPromptVars } from "../../src/implement/prompt.js";

const template = readFileSync(fileURLToPath(new URL("../../prompts/implement.md", import.meta.url)), "utf8");
const vars: ImplementPromptVars = {
  identifier: "API-1",
  teamKey: "API",
  teamName: "API",
  ticket: "# API-1: Adapter drops the last chunk",
  workspacePath: "/work/1-1",
  baseBranch: "dev",
  sha: "a".repeat(40),
  artifactsDir: "/jobs/1/artifacts",
  stewardPort: 4100,
  hasBrief: false,
  brief: "",
  branchTypes: "feature, fix, chore, refactor",
  hasChecks: false,
  checks: "",
};

describe("implement prompt", () => {
  it("asks for investigation first without a brief", () => {
    const prompt = renderImplementPrompt(template, vars);
    expect(prompt).toContain("Investigate first");
    expect(prompt).not.toContain("## Agent brief");
    expect(prompt).toContain("feature, fix, chore, refactor");
  });

  it("asks the agent to commit with the identifier and push through the push tool", () => {
    const prompt = renderImplementPrompt(template, vars);
    expect(prompt).toContain("Every commit subject starts with `API-1: `");
    expect(prompt).toContain("Call the `push` tool with `branchType` set to one of: feature, fix, chore, refactor");
    expect(prompt).not.toContain("commitMessage");
  });

  it("asks the agent to verify only what its change affects", () => {
    const prompt = renderImplementPrompt(template, vars);
    expect(prompt).toContain("## Verify what your change affects");
    expect(prompt).not.toContain("the steward runs these itself");
  });

  it("lists the steward's own checks when there are some", () => {
    const prompt = renderImplementPrompt(template, { ...vars, hasChecks: true, checks: "- `pnpm turbo check-types lint --filter='...[abc]'`" });
    expect(prompt).toContain("the steward runs these itself, and a failure refuses the push:\n\n- `pnpm turbo check-types lint --filter='...[abc]'`");
  });

  it("uses the brief as the spec when there is one", () => {
    const prompt = renderImplementPrompt(template, { ...vars, hasBrief: true, brief: "Goal: <keep> & flush." });
    expect(prompt).toContain("## Agent brief\n\nGoal: <keep> & flush.");
    expect(prompt).not.toContain("Investigate first");
  });
});
