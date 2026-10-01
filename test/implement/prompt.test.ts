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
};

describe("implement prompt", () => {
  it("asks for investigation first without a brief", () => {
    const prompt = renderImplementPrompt(template, vars);
    expect(prompt).toContain("Investigate first");
    expect(prompt).not.toContain("## Agent brief");
    expect(prompt).toContain("feature, fix, chore, refactor");
  });

  it("uses the brief as the spec when there is one", () => {
    const prompt = renderImplementPrompt(template, { ...vars, hasBrief: true, brief: "Goal: <keep> & flush." });
    expect(prompt).toContain("## Agent brief\n\nGoal: <keep> & flush.");
    expect(prompt).not.toContain("Investigate first");
  });
});
