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

  it("leaves a quick action inside a fenced block as it is", () => {
    const text = "Run:\n```\n/merge\n@ada\n```\n/close";
    expect(neutralizeGitLab(text)).toBe(`Run:\n\`\`\`\n/merge\n@ada\n\`\`\`\n${ZWSP}/close`);
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
