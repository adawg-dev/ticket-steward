import { describe, expect, it } from "vitest";
import type { MergeRequestInfo, MrDiscussion, MrNote } from "../../src/codehost/gitlabMr.js";
import { findSummary, openFindings, parseSummary, shaMatches } from "../../src/greptile/summary.js";

const SHA = "abc1234ef567890abc1234ef567890abc1234ef";
const fixture = (n: number, sha = SHA): string => `<h3>Greptile Summary</h3>

This MR adds a retry loop.

### Confidence Score: 4/5

- Safe to merge after the minor fix.

<sub>Reviews (${n}): Last reviewed commit: [fix: retry](https://gitlab.com/acme/app/-/commit/${sha})</sub>`;

const mr = (description: string): MergeRequestInfo => ({
  projectId: 1, iid: 2, state: "opened", sha: SHA, title: "t", description, webUrl: "u",
  sourceBranch: "b", targetBranch: "main", updatedAt: "2026-01-01T00:00:00Z", headPipeline: null,
});
const note = (over: Partial<MrNote>): MrNote => ({
  id: 1, body: "", author: "greptile-bot", system: false, resolvable: false, resolved: false,
  type: null, createdAt: "2026-01-02T00:00:00Z", updatedAt: "2026-01-02T00:00:00Z", position: null, ...over,
});

describe("parseSummary", () => {
  it("parses score, review count and last reviewed sha", () => {
    const s = parseSummary(fixture(3), "t", "note");
    expect(s).toMatchObject({ score: 4, reviewCount: 3, lastReviewedSha: SHA, updatedAt: "t", source: "note" });
  });
  it("returns null without a score heading", () => {
    expect(parseSummary("just text", "t", "note")).toBeNull();
  });
  it("returns null for a score outside 0-5", () => {
    expect(parseSummary("Confidence Score: 9/5", "t", "note")).toBeNull();
  });
});

describe("findSummary", () => {
  it("prefers the candidate with the highest review count", () => {
    const d: MrDiscussion[] = [{ id: "d", notes: [note({ body: fixture(3) })] }];
    expect(findSummary(mr(fixture(2)), d, "greptile-bot")?.source).toBe("note");
    expect(findSummary(mr(fixture(2)), d, "greptile-bot")?.reviewCount).toBe(3);
  });
  it("ignores notes by other authors and breaks ties by newest", () => {
    const d: MrDiscussion[] = [{ id: "d", notes: [note({ id: 5, author: "human", body: fixture(9) })] }];
    expect(findSummary(mr(fixture(2)), d, "greptile-bot")?.source).toBe("description");
    const tie: MrDiscussion[] = [{ id: "d", notes: [note({ body: fixture(2) })] }];
    expect(findSummary(mr(fixture(2)), tie, "greptile-bot")?.source).toBe("note");
  });
  it("returns null when nothing matches", () => {
    expect(findSummary(mr("nope"), [], "greptile-bot")).toBeNull();
  });
});

describe("shaMatches", () => {
  it("prefix-matches at least 7 hex chars", () => {
    expect(shaMatches("abc1234", SHA)).toBe(true);
    expect(shaMatches("abc123", SHA)).toBe(false);
    expect(shaMatches("def1234", SHA)).toBe(false);
    expect(shaMatches(null, SHA)).toBe(false);
  });
});

describe("openFindings", () => {
  const pos = { newPath: "src/a.ts", oldPath: "src/a.ts", newLine: 12, oldLine: null };
  it("keeps unresolved resolvable bot threads and drops the rest", () => {
    const body = "Bug here\n```suggestion\nconst x = 1;\n```\n";
    const d: MrDiscussion[] = [
      { id: "open", notes: [note({ body, resolvable: true, type: "DiffNote", position: pos })] },
      { id: "resolved", notes: [note({ resolvable: true, resolved: true })] },
      { id: "human", notes: [note({ author: "human", resolvable: true })] },
      { id: "plain", notes: [note({ resolvable: false })] },
    ];
    expect(openFindings(d, "greptile-bot")).toEqual([
      { discussionId: "open", body, filePath: "src/a.ts", lineStart: 12, lineEnd: 12, suggestedCode: "const x = 1;\n" },
    ]);
  });
  it("has null suggestion and position when absent", () => {
    const d: MrDiscussion[] = [{ id: "x", notes: [note({ resolvable: true, body: "hi" })] }];
    expect(openFindings(d, "greptile-bot")[0]).toMatchObject({ filePath: null, lineStart: null, lineEnd: null, suggestedCode: null });
  });
});
