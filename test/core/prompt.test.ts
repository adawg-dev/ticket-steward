import { readFileSync } from "node:fs";
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
  gateway: null,
  isBug: false,
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
    expect(rendered).toContain("Reference files as `relative/path.ts:line`");
  });

  it("renders the gateway block only for gateway tickets", async () => {
    const template = await readFile("prompts/enrich.md", "utf8");
    expect(renderPrompt(template, vars)).not.toContain("ticket-gateway");
    const out = renderPrompt(template, { ...vars, gateway: { className: "billing", teamKey: "PLAT" } });
    expect(out).toContain("filed through ticket-gateway");
    expect(out).toContain("routed it as class `billing` to team PLAT");
    expect(out).toContain("untrusted");
  });
});

const shipped = readFileSync(new URL("../../prompts/enrich.md", import.meta.url), "utf8");
const reproVars = (isBug: boolean): PromptVars => ({
  ticket: "T",
  templates: "",
  workspacePath: "/w",
  baseBranch: "main",
  sha: "abc",
  artifactsDir: "/a",
  teamKey: "API",
  teamName: "API",
  stewardPort: 4100,
  gateway: null,
  isBug,
});

describe("enrich prompt reproduction section", () => {
  it("asks for a reproduction on bug tickets", () => {
    const text = renderPrompt(shipped, reproVars(true));
    expect(text).toContain("## Reproduce the bug");
    expect(text).toContain("port 4100");
    expect(text).not.toContain("set `repro` to null");
  });

  it("tells the brain to return a null repro otherwise", () => {
    const text = renderPrompt(shipped, reproVars(false));
    expect(text).not.toContain("## Reproduce the bug");
    expect(text).toContain("set `repro` to null");
  });
});
