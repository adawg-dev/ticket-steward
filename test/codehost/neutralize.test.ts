import { neutralizeGitLab } from "../../src/codehost/neutralize.js";

const ZWSP = "​";
const WJ = "⁠";

describe("neutralizeGitLab", () => {
  it("breaks a quick action at the start of a line", () => {
    expect(neutralizeGitLab("Done.\n/merge\n/target_branch main")).toBe(`Done.\n${ZWSP}/merge\n${ZWSP}/target_branch main`);
  });

  it("breaks an indented quick action", () => {
    expect(neutralizeGitLab("  /approve")).toBe(`  ${ZWSP}/approve`);
  });

  it("breaks quick actions and mentions inside and after fenced blocks too", () => {
    const text = "Run:\n```\n/merge\n@ada\n```\n/close";
    expect(neutralizeGitLab(text)).toBe(`Run:\n\`\`\`\n${ZWSP}/merge\n@${WJ}ada\n\`\`\`\n${ZWSP}/close`);
  });

  it("is not bypassed by an unclosed fence, a tilde fence or an indented fence", () => {
    expect(neutralizeGitLab("Note:\n```\n/merge\n@ada")).toBe(`Note:\n\`\`\`\n${ZWSP}/merge\n@${WJ}ada`);
    expect(neutralizeGitLab("~~~\n/merge\n~~~")).toBe(`~~~\n${ZWSP}/merge\n~~~`);
    expect(neutralizeGitLab("    ```\n/merge\n@ada\n    ```")).toBe(`    \`\`\`\n${ZWSP}/merge\n@${WJ}ada\n    \`\`\``);
  });

  it("breaks a mention after a slash unless it sits in an http(s) URL", () => {
    expect(neutralizeGitLab("a/@ada and /@sam")).toBe(`a/@${WJ}ada and /@${WJ}sam`);
    expect(neutralizeGitLab("x://@ada")).toBe(`x://@${WJ}ada`);
    const link = "[x](https://medium.com/@ada) and <https://h.example/u/@sam>";
    expect(neutralizeGitLab(link)).toBe(link);
  });

  it("leaves a path mid-line and a slash not followed by a letter as they are", () => {
    const text = "See https://gitlab.example/acme/repo/-/merge_requests/7 and src/a.ts\n/ 2\n//comment";
    expect(neutralizeGitLab(text)).toBe(text);
  });

  it("breaks an @ mention at the start, after a space and after punctuation", () => {
    expect(neutralizeGitLab("@ada and @sam, (@lee)")).toBe(`@${WJ}ada and @${WJ}sam, (@${WJ}lee)`);
  });

  it("leaves an email address and a bare @ as they are", () => {
    const text = "Write to a@b.com or first.last@x.org; @ alone; @@ -1,2 +1,3 @@";
    expect(neutralizeGitLab(text)).toBe(text);
  });
});
