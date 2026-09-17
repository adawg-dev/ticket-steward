import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { listFiles } from "./files.js";
import { git } from "./git.js";

const SYNC_SKIP_DIRS = [".git", "node_modules", ".next", "dist"];

const writePrivate = async (target: string, content: string): Promise<void> => {
  await mkdir(dirname(target), { recursive: true, mode: 0o700 });
  await writeFile(target, content, { mode: 0o600 });
  await chmod(target, 0o600);
};

const rewritePorts = (content: string, rewrite: { from: number; to: number }): string =>
  content.replaceAll(`localhost:${rewrite.from}`, `localhost:${rewrite.to}`).replaceAll(`127.0.0.1:${rewrite.from}`, `127.0.0.1:${rewrite.to}`);

const isTracked = async (worktreePath: string, file: string): Promise<boolean> => {
  const result = await git(["ls-files", "--error-unmatch", "--", file], worktreePath);
  return result.exitCode === 0;
};

export const copyOverlay = async (
  overlayDir: string,
  worktreePath: string,
  opts: { portRewrite?: { from: number; to: number } },
): Promise<{ copied: string[] }> => {
  const files = await listFiles(overlayDir);
  for (const file of files) {
    if (await isTracked(worktreePath, file)) {
      throw new Error(`overlay refuses to overwrite tracked path ${file}`);
    }
  }
  for (const file of files) {
    const content = await readFile(join(overlayDir, file), "utf8");
    const rewritten = opts.portRewrite === undefined ? content : rewritePorts(content, opts.portRewrite);
    await writePrivate(join(worktreePath, file), rewritten);
  }
  return { copied: files };
};

const envValues = (content: string): Array<{ key: string; value: string }> =>
  content.split(/\r?\n/).flatMap((line) => {
    const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (match === null) return [];
    const [, key = "", raw = ""] = match;
    const value = raw.trim().replace(/^(["'])(.*)\1$/, "$2");
    return [{ key, value }];
  });

const ignoredFiles = async (checkoutPath: string, files: string[]): Promise<string[]> => {
  if (files.length === 0) return [];
  const result = await git(["check-ignore", "--", ...files], checkoutPath);
  return result.stdout === "" ? [] : result.stdout.split("\n");
};

export const syncOverlayFromCheckout = async (
  checkoutPath: string,
  overlayDir: string,
  opts: { denyPatterns: RegExp[]; allowPatterns: RegExp[] },
): Promise<{ copied: string[]; refused: Array<{ file: string; reason: string }> }> => {
  const candidates = (await listFiles(checkoutPath, SYNC_SKIP_DIRS)).filter((file) => /^\.env(?:$|\.)/.test(file.split("/").at(-1) ?? ""));
  const files = await ignoredFiles(checkoutPath, candidates);
  const copied: string[] = [];
  const refused: Array<{ file: string; reason: string }> = [];
  for (const file of files) {
    const content = await readFile(join(checkoutPath, file), "utf8");
    const denied = envValues(content).find(
      ({ value }) => opts.denyPatterns.some((p) => p.test(value)) && !opts.allowPatterns.some((p) => p.test(value)),
    );
    if (denied !== undefined) {
      refused.push({ file, reason: `${denied.key} matches a deny pattern` });
      continue;
    }
    await writePrivate(join(overlayDir, file), content);
    copied.push(file);
  }
  return { copied, refused };
};
