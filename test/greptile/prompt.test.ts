import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { renderFixPrompt, type FixPromptInput } from "../../src/greptile/prompt.js";

const input: FixPromptInput = {
  identifier: "ENG-1", round: 2, maxRounds: 5, score: 3, summary: "Confidence Score: 3/5 <b>raw</b>",
  findings: [{ discussionId: "disc-abc", body: "use a map", filePath: "src/foo.ts", lineStart: 4, lineEnd: 6, suggestedCode: "const m = new Map();" }],
  ciFailures: [{ name: "unit-tests", stage: "test", webUrl: "https://gl/1", logTail: "AssertionError: boom" }],
  personCommits: ["abc123 tweak copy"], newComments: [{ author: "Sam", body: "also handle empty" }],
  workspacePath: "/ws", headSha: "deadbeef", stewardPort: 4321, artifactsDir: "/art", checks: "- `pnpm lint`", hasChecks: true,
};

describe("renderFixPrompt", () => {
  it("renders the round, findings, CI failures and context", async () => {
    const out = renderFixPrompt(await readFile("prompts/fix.md", "utf8"), input);
    expect(out).toContain("round 2 of 5");
    expect(out).toContain("disc-abc");
    expect(out).toContain("src/foo.ts:4");
    expect(out).toContain("const m = new Map();");
    expect(out).toContain("unit-tests");
    expect(out).toContain("AssertionError: boom");
    expect(out).toContain("<b>raw</b>");
    expect(out).toContain("abc123 tweak copy");
    expect(out).toContain("also handle empty");
    expect(out).toContain("4321");
    expect(out).toContain("pnpm lint");
    expect(out).not.toMatch(/@greptile/i);
  });
  it("omits optional sections when empty", async () => {
    const out = renderFixPrompt(await readFile("prompts/fix.md", "utf8"), { ...input, findings: [], ciFailures: [], personCommits: [], newComments: [], hasChecks: false });
    expect(out).not.toContain("tweak copy");
    expect(out).not.toContain("also handle empty");
    expect(out).not.toContain("pnpm lint");
  });
});
