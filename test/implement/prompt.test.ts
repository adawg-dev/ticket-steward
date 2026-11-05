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
  reply: "",
  small: true,
  standard: false,
  design: false,
  hasDesign: false,
  designText: "",
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

  it("shows a person's answer to the agent's questions, and nothing of it on a fresh implement", () => {
    expect(renderImplementPrompt(template, vars)).not.toContain("Your questions were answered");
    const prompt = renderImplementPrompt(template, { ...vars, reply: "Use the S3 adapter <v2>." });
    expect(prompt).toContain("## Your questions were answered");
    expect(prompt).toContain("Use the S3 adapter <v2>.");
  });

  it("renders only the section of the run's level", () => {
    const levels = "{{#small}}S{{/small}}{{#standard}}T{{/standard}}{{#design}}D{{/design}}";
    expect(renderImplementPrompt(levels, vars)).toBe("S");
    expect(renderImplementPrompt(levels, { ...vars, small: false, design: true })).toBe("D");
  });

  describe("process levels", () => {
    const small = renderImplementPrompt(template, vars);
    const standard = renderImplementPrompt(template, { ...vars, small: false, standard: true });
    const design = renderImplementPrompt(template, { ...vars, small: false, design: true });

    it("gives a small run one simplify pass over its diff and no plan or design", () => {
      expect(small).toContain(`run the \`steward-simplify\` skill on \`git diff ${"a".repeat(40)}\` (your whole change, committed or not)`);
      expect(small).not.toContain("Using `egm-draft`");
      expect(small).not.toContain("For each task in the plan");
      expect(small).not.toContain("egm-draft");
      expect(small).toMatchSnapshot();
    });

    it("gives a standard run a plan in the artifacts dir and per-task simplify, without a design", () => {
      expect(standard).toContain("`steward-plan`");
      expect(standard).toContain("/jobs/1/artifacts/plan.md");
      expect(standard).toContain("For each task in the plan");
      expect(standard).not.toContain("subagent_type");
      expect(standard).toContain("on the task's uncommitted diff (`git diff HEAD`), then commit");
      expect(standard).toMatchSnapshot();
    });

    it("gives a design run an EGM design reviewed by the goldfish subagent, then the standard steps", () => {
      expect(design).toContain("/jobs/1/artifacts/design.md");
      expect(design).toContain("`egm-draft`");
      expect(design).toContain("subagent_type `goldfish`");
      expect(design).toContain("`steward-plan`");
      expect(design).not.toMatch(/\bTask\b/);
      expect(design).toMatchSnapshot();
    });

    it("names the step-up triggers below the design level", () => {
      expect(small).toContain("migrations, auth/RBAC, multi-tenancy or billing/credits");
      expect(small).toContain("step up to `standard`");
      expect(standard).toContain("step up to `design`");
      for (const prompt of [standard, design]) {
        expect(prompt).toContain("Its design-only rule (no production code) ends when you approve the design, and never applies to code you already wrote.");
        expect(prompt).toContain("Skip its save-location step and its hand-off to `egm-review`.");
        expect(prompt).toContain("choose the one that fits the ticket and the code best");
      }
      expect(design).not.toContain("Step up a level");
    });

    it("asks every level for the level and design result fields and keeps plans and designs out of commits", () => {
      for (const prompt of [small, standard, design]) {
        expect(prompt).toContain("- `level`: `started`");
        expect(prompt).toContain("- `design`: the text of `/jobs/1/artifacts/design.md`");
        expect(prompt).toContain("(`design.md`, `plan.md`) live only in `/jobs/1/artifacts` and are never committed");
      }
      expect(standard).toContain("the level this run was given (`standard`)");
    });

    it("continues from the design so far when answers resume a design run", () => {
      const resumed = renderImplementPrompt(template, { ...vars, small: false, design: true, hasDesign: true, designText: "# Flush <all> chunks" });
      expect(resumed).toContain("# Flush <all> chunks");
      expect(design).not.toContain("design so far");
    });
  });
});
