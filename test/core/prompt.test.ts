import { readFile } from "node:fs/promises";
import { renderPrompt } from "../../src/core/prompt.js";
import type { PromptVars } from "../../src/core/prompt.js";

const vars: PromptVars = {
  ticket: "# API-1 <Login> fails & hangs",
  templates: "## Bugs",
  workspacePath: "/tmp/work/42-1",
  baseBranch: "dev",
  sha: "1a2b3c4d5e6f",
  artifactsDir: "/tmp/jobs/42/artifacts",
  teamKey: "API",
  teamName: "API Team",
  stewardPort: 4100,
  operatorInstructions: "Focus on the auth middleware.",
};

describe("renderPrompt", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("substitutes variables without HTML escaping", () => {
    expect(renderPrompt("Ticket:\n{{ticket}}\nPort {{stewardPort}} at {{workspacePath}}", vars)).toBe(
      "Ticket:\n# API-1 <Login> fails & hangs\nPort 4100 at /tmp/work/42-1",
    );
  });

  it("renders the default prompt with every variable filled", async () => {
    const template = await readFile(new URL("../../prompts/enrich.md", import.meta.url), "utf8");
    const rendered = renderPrompt(template, vars);
    expect(rendered).not.toContain("{{");
    expect(rendered).toContain("# API-1 <Login> fails & hangs");
    expect(rendered).toContain("## Bugs");
    expect(rendered).toContain("/tmp/work/42-1");
    expect(rendered).toContain("dev");
    expect(rendered).toContain("1a2b3c4d5e6f");
    expect(rendered).toContain("/tmp/jobs/42/artifacts");
    expect(rendered).toContain("API Team");
    expect(rendered).toContain("4100");
    expect(rendered).toContain("Focus on the auth middleware.");
    expect(rendered).toContain("Reference files as `relative/path.ts:line`");
  });
});
