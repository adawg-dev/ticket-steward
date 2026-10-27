import { isBugTicket, normalizeRepro, renderReproMarkdown } from "../../src/core/repro.js";
import type { BrainResult } from "../../src/core/result.js";

const result: BrainResult = {
  template: { matched: null, conforms: true, missing: [] },
  summary: "s",
  enrichment: "e",
  attachments: [],
  confidence: "high",
  repro: { status: "reproduced", method: "http", command: "curl -s localhost:4100/v1/x", steps: [], files: [], expected: "200", observed: "500" },
  triage: { state: "ready-for-human", questions: [], agentBrief: "Goal: keep the last chunk." },
};

describe("isBugTicket", () => {
  it("matches a configured label ignoring case and whitespace", () => {
    expect(isBugTicket(["bug "], ["Bug"])).toBe(true);
    expect(isBugTicket(["Feature", "Defect"], ["Bug", "defect"])).toBe(true);
  });

  it("is false without a matching label", () => {
    expect(isBugTicket(["Feature"], ["Bug"])).toBe(false);
    expect(isBugTicket([], ["Bug"])).toBe(false);
  });
});

describe("normalizeRepro", () => {
  it("keeps the recipe for bugs", () => {
    expect(normalizeRepro(result, true).repro).toEqual(result.repro);
  });

  it("drops any recipe for non-bugs", () => {
    expect(normalizeRepro(result, false).repro).toBeNull();
  });
});

describe("renderReproMarkdown", () => {
  it("renders the recipe as a readable block", () => {
    const text = renderReproMarkdown({
      status: "reproduced",
      method: "test",
      command: "pnpm vitest run a.test.ts",
      steps: ["Start nothing", "Run the test"],
      files: ["a.test.ts"],
      expected: "passes",
      observed: "fails with 500",
    });
    expect(text).toBe(
      [
        "### Reproduction",
        "",
        "**Status:** reproduced · **Method:** test",
        "",
        "**Command** (from the workspace root):",
        "",
        "```sh",
        "pnpm vitest run a.test.ts",
        "```",
        "",
        "**Steps:**",
        "",
        "1. Start nothing",
        "2. Run the test",
        "",
        "**Expected:** passes",
        "",
        "**Observed:** fails with 500",
        "",
        "**Recipe files:** `a.test.ts`",
      ].join("\n"),
    );
  });

  it("switches to a tilde fence when the command contains backticks", () => {
    expect(renderReproMarkdown({ status: "not_reproduced", method: "script", command: "echo ```", steps: [], files: [], expected: "a", observed: "b" })).toContain("~~~sh\necho ```\n~~~");
  });
});
