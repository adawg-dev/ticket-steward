import { anchorFor, parseDiffAnchors, toPosition } from "../../src/review/diff.js";

const DIFF = [
  "diff --git a/src/adapter.ts b/src/adapter.ts",
  "index 1111111..2222222 100644",
  "--- a/src/adapter.ts",
  "+++ b/src/adapter.ts",
  "@@ -1,4 +1,5 @@",
  " export const a = 1;",
  "-export const b = 2;",
  "+export const b = 3;",
  "+export const c = 4;",
  " export const d = 5;",
  " export const e = 6;",
  "@@ -10,2 +11,3 @@ export const j = 10;",
  " export const k = 11;",
  "+export const l = 12;",
  " export const m = 13;",
  "diff --git a/src/old.ts b/src/renamed.ts",
  "similarity index 90%",
  "rename from src/old.ts",
  "rename to src/renamed.ts",
  "index 3333333..4444444 100644",
  "--- a/src/old.ts",
  "+++ b/src/renamed.ts",
  "@@ -3 +3 @@",
  "-const x = 1;",
  "+const x = 2;",
  "diff --git a/src/new.ts b/src/new.ts",
  "new file mode 100644",
  "index 0000000..5555555",
  "--- /dev/null",
  "+++ b/src/new.ts",
  "@@ -0,0 +1,2 @@",
  "+export const fresh = 1;",
  "+++ not a header",
  "diff --git a/src/gone.ts b/src/gone.ts",
  "deleted file mode 100644",
  "index 6666666..0000000",
  "--- a/src/gone.ts",
  "+++ /dev/null",
  "@@ -1,2 +0,0 @@",
  "-export const gone = 1;",
  "--- also not a header",
  "diff --git a/logo.png b/logo.png",
  "index 7777777..8888888 100644",
  "Binary files a/logo.png and b/logo.png differ",
  "",
].join("\n");

const files = parseDiffAnchors(DIFF);
const at = (path: string, line: number, side: "new" | "old") => anchorFor(files, { path, line, side });

describe("anchorFor", () => {
  it("anchors added lines by new line only", () => {
    expect(at("src/adapter.ts", 3, "new")).toEqual({ oldPath: "src/adapter.ts", newPath: "src/adapter.ts", oldLine: null, newLine: 3 });
    expect(at("src/adapter.ts", 12, "new")).toEqual({ oldPath: "src/adapter.ts", newPath: "src/adapter.ts", oldLine: null, newLine: 12 });
  });

  it("anchors unchanged lines by both numbers", () => {
    expect(at("src/adapter.ts", 4, "new")).toEqual({ oldPath: "src/adapter.ts", newPath: "src/adapter.ts", oldLine: 3, newLine: 4 });
    expect(at("src/adapter.ts", 13, "new")).toEqual({ oldPath: "src/adapter.ts", newPath: "src/adapter.ts", oldLine: 11, newLine: 13 });
    expect(at("src/adapter.ts", 11, "old")).toEqual({ oldPath: "src/adapter.ts", newPath: "src/adapter.ts", oldLine: 11, newLine: 13 });
  });

  it("anchors removed lines by old line only", () => {
    expect(at("src/adapter.ts", 2, "old")).toEqual({ oldPath: "src/adapter.ts", newPath: "src/adapter.ts", oldLine: 2, newLine: null });
  });

  it("returns null outside the hunks and for unknown files", () => {
    expect(at("src/adapter.ts", 8, "new")).toBeNull();
    expect(at("src/adapter.ts", 2, "new")).toEqual({ oldPath: "src/adapter.ts", newPath: "src/adapter.ts", oldLine: null, newLine: 2 });
    expect(at("src/missing.ts", 1, "new")).toBeNull();
    expect(at("logo.png", 1, "new")).toBeNull();
  });

  it("keeps both paths for a rename", () => {
    expect(at("src/renamed.ts", 3, "new")).toEqual({ oldPath: "src/old.ts", newPath: "src/renamed.ts", oldLine: null, newLine: 3 });
    expect(at("src/old.ts", 3, "old")).toEqual({ oldPath: "src/old.ts", newPath: "src/renamed.ts", oldLine: 3, newLine: null });
  });

  it("uses one path for new and deleted files, and treats header-like lines in hunks as content", () => {
    expect(at("src/new.ts", 2, "new")).toEqual({ oldPath: "src/new.ts", newPath: "src/new.ts", oldLine: null, newLine: 2 });
    expect(at("src/gone.ts", 2, "old")).toEqual({ oldPath: "src/gone.ts", newPath: "src/gone.ts", oldLine: 2, newLine: null });
  });
});

describe("toPosition", () => {
  it("combines an anchor with the diff refs", () => {
    expect(toPosition({ oldPath: "a", newPath: "b", oldLine: null, newLine: 3 }, { baseSha: "1", startSha: "2", headSha: "3" })).toEqual({
      baseSha: "1", startSha: "2", headSha: "3", oldPath: "a", newPath: "b", oldLine: null, newLine: 3,
    });
  });
});
