import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { renderFixPrompt, type FixPromptInput } from "../../src/greptile/prompt.js";

const input: FixPromptInput = {
  identifier: "ENG-1", round: 2, score: 3, summary: "Confidence Score: 3/5 <b>raw</b>",
  comments: [
    {
      discussionId: "disc-abc", author: "greptile-bot", isBot: true, body: "use a map\n\n```suggestion\nconst m = new Map();\n```",
      position: { newPath: "src/foo.ts", oldPath: "src/foo.ts", newLine: 4, oldLine: null },
    },
    { discussionId: "disc-def", author: "Sam", isBot: false, body: "also handle empty", position: null },
  ],
  ciFailures: [{ name: "unit-tests", stage: "test", webUrl: "https://gl/1", logTail: "AssertionError: boom" }],
  personCommits: ["abc123 tweak copy"], decisions: ["Keep the v1 endpoint"],
  workspacePath: "/ws", headSha: "deadbeef", stewardPort: 4321, artifactsDir: "/art", checks: "- `pnpm lint`", hasChecks: true,
};

describe("renderFixPrompt", () => {
  it("renders the round, the comments to answer, CI failures and context", async () => {
    const out = renderFixPrompt(await readFile("prompts/fix.md", "utf8"), input);
    expect(out).toContain("round 2");
    expect(out).toContain("## Comments to answer");
    expect(out).toContain("### Thread `disc-abc`: greptile-bot (bot) at src/foo.ts:4");
    expect(out).toContain("const m = new Map();");
    expect(out).toContain("### Thread `disc-def`: Sam (person) at a general comment");
    expect(out).toContain("also handle empty");
    expect(out).toContain("Never resolve a thread");
    expect(out).toContain("unit-tests");
    expect(out).toContain("AssertionError: boom");
    expect(out).toContain("<b>raw</b>");
    expect(out).toContain("abc123 tweak copy");
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
  it("omits optional sections when empty, Greptile's summary included when it is off", async () => {
    const out = renderFixPrompt(await readFile("prompts/fix.md", "utf8"), { ...input, score: null, summary: null, comments: [], ciFailures: [], personCommits: [], decisions: [], hasChecks: false });
    expect(out).not.toContain("tweak copy");
    expect(out).not.toContain("Decisions a person made");
    expect(out).not.toContain("also handle empty");
    expect(out).not.toContain("pnpm lint");
    expect(out).not.toContain("Greptile");
    expect(out).not.toContain("## Comments to answer");
    expect(out).toContain("Nothing is waiting for an answer");
  });
});
