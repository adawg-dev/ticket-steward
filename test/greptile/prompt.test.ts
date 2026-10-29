import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { renderFixPrompt, type FixPromptInput } from "../../src/greptile/prompt.js";

const input: FixPromptInput = {
  identifier: "ENG-1", round: 2, maxRounds: 5, score: 3, summary: "Confidence Score: 3/5 <b>raw</b>",
  findings: [{ discussionId: "disc-abc", body: "use a map", filePath: "src/foo.ts", lineStart: 4, lineEnd: 6, suggestedCode: "const m = new Map();" }],
  ciFailures: [{ name: "unit-tests", stage: "test", webUrl: "https://gl/1", logTail: "AssertionError: boom" }],
  personCommits: ["abc123 tweak copy"], newComments: [{ author: "Sam", body: "also handle empty" }], decisions: ["Keep the v1 endpoint"],
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
    expect(out).toContain("## Decisions a person made on this merge request: never undo these\n\n- Keep the v1 endpoint\n");
    expect(out).not.toMatch(/@greptile/i);
  });
  it("has the agent commit with the identifier and push through the push tool", async () => {
    const out = renderFixPrompt(await readFile("prompts/fix.md", "utf8"), input);
    expect(out).toContain("starts with `ENG-1: `");
    expect(out).toContain("Call the `push` tool");
    expect(out).toContain("on top of `deadbeef`");
    expect(out).not.toContain("commitMessage");
    expect(out).not.toContain("Never run `git commit`");
  });
  it("omits optional sections when empty", async () => {
    const out = renderFixPrompt(await readFile("prompts/fix.md", "utf8"), { ...input, findings: [], ciFailures: [], personCommits: [], newComments: [], decisions: [], hasChecks: false });
    expect(out).not.toContain("tweak copy");
    expect(out).not.toContain("Decisions a person made");
    expect(out).not.toContain("also handle empty");
    expect(out).not.toContain("pnpm lint");
  });
});
