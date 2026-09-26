import type { DiffPosition, DiffRefs } from "../codehost/gitlabReview.js";

export interface FileAnchors {
  oldPath: string;
  newPath: string;
  added: Set<number>;
  removed: Set<number>;
  contextByNew: Map<number, number>;
  contextByOld: Map<number, number>;
}

export interface LineAnchor {
  oldPath: string;
  newPath: string;
  oldLine: number | null;
  newLine: number | null;
}

const HUNK = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

/** Path from a `---`/`+++` header, or null for /dev/null. Quoted paths lose their quotes; escapes are not decoded. */
const headerPath = (raw: string, prefix: string): string | null => {
  const value = raw.trim().replace(/^"(.*)"$/, "$1");
  if (value === "/dev/null") return null;
  return value.startsWith(prefix) ? value.slice(prefix.length) : value;
};

/** Parses `git diff` output into the lines GitLab accepts a diff note on. */
export const parseDiffAnchors = (diff: string): FileAnchors[] => {
  const files: FileAnchors[] = [];
  let current: FileAnchors | null = null;
  let oldHeader: string | null = null;
  let inHunk = false;
  let oldLine = 0;
  let newLine = 0;
  for (const line of diff.split("\n")) {
    if (line.startsWith("diff --git ")) {
      current = null;
      oldHeader = null;
      inHunk = false;
      continue;
    }
    if (!inHunk && line.startsWith("--- ")) {
      oldHeader = headerPath(line.slice(4), "a/");
      continue;
    }
    if (!inHunk && line.startsWith("+++ ")) {
      const newHeader = headerPath(line.slice(4), "b/");
      const path = newHeader ?? oldHeader ?? "";
      current = { oldPath: oldHeader ?? path, newPath: newHeader ?? path, added: new Set(), removed: new Set(), contextByNew: new Map(), contextByOld: new Map() };
      files.push(current);
      continue;
    }
    const hunk = HUNK.exec(line);
    if (hunk !== null && current !== null) {
      oldLine = Number(hunk[1]);
      newLine = Number(hunk[2]);
      inHunk = true;
      continue;
    }
    if (!inHunk || current === null) continue;
    if (line.startsWith("+")) {
      current.added.add(newLine);
      newLine += 1;
    } else if (line.startsWith("-")) {
      current.removed.add(oldLine);
      oldLine += 1;
    } else if (line.startsWith(" ")) {
      current.contextByNew.set(newLine, oldLine);
      current.contextByOld.set(oldLine, newLine);
      oldLine += 1;
      newLine += 1;
    }
  }
  return files;
};

export const anchorFor = (files: FileAnchors[], comment: { path: string; line: number; side: "new" | "old" }): LineAnchor | null => {
  if (comment.side === "new") {
    const file = files.find((item) => item.newPath === comment.path);
    if (file === undefined) return null;
    if (file.added.has(comment.line)) return { oldPath: file.oldPath, newPath: file.newPath, oldLine: null, newLine: comment.line };
    const old = file.contextByNew.get(comment.line);
    return old === undefined ? null : { oldPath: file.oldPath, newPath: file.newPath, oldLine: old, newLine: comment.line };
  }
  const file = files.find((item) => item.oldPath === comment.path) ?? files.find((item) => item.newPath === comment.path);
  if (file === undefined) return null;
  if (file.removed.has(comment.line)) return { oldPath: file.oldPath, newPath: file.newPath, oldLine: comment.line, newLine: null };
  const next = file.contextByOld.get(comment.line);
  return next === undefined ? null : { oldPath: file.oldPath, newPath: file.newPath, oldLine: comment.line, newLine: next };
};

export const toPosition = (anchor: LineAnchor, refs: DiffRefs): DiffPosition => ({
  baseSha: refs.baseSha,
  startSha: refs.startSha,
  headSha: refs.headSha,
  oldPath: anchor.oldPath,
  newPath: anchor.newPath,
  oldLine: anchor.oldLine,
  newLine: anchor.newLine,
});
