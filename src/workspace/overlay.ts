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

/** A `KEY=value` line, optionally `export `-prefixed and indented, with whitespace allowed before `=`. */
const ENV_LINE = /^(\s*)(export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/;

/** Slot overrides named keys no overlay file defines: a config problem, so the job fails without a retry. */
export class OverrideKeysError extends Error {
  constructor(readonly keys: string[]) {
    super(`slot override keys not found in the overlay: ${keys.join(", ")}`);
  }
}

const envKeys = (content: string): string[] =>
  content.split("\n").flatMap((line) => {
    const key = ENV_LINE.exec(line)?.[3];
    return key === undefined ? [] : [key];
  });

/** Rewrites the lines whose key `overrides` names: a string replaces the value (unquoted), null removes the line; every other line stays. */
const applyOverrides = (content: string, overrides: Record<string, string | null>): string =>
  content
    .split("\n")
    .flatMap((line) => {
      const match = ENV_LINE.exec(line);
      const key = match?.[3];
      if (match === null || key === undefined || !Object.hasOwn(overrides, key)) return [line];
      const value = overrides[key];
      if (value === undefined) return [line];
      if (value === null) return [];
      const eol = line.endsWith("\r") ? "\r" : "";
      return [`${match[1] ?? ""}${match[2] === undefined ? "" : "export "}${key}=${value}${eol}`];
    })
    .join("\n");

export const copyOverlay = async (
  overlayDir: string,
  worktreePath: string,
  opts: { portRewrite?: { from: number; to: number }; overrides?: Record<string, string | null> },
): Promise<{ copied: string[] }> => {
  const files = await listFiles(overlayDir);
  for (const file of files) {
    if (await isTracked(worktreePath, file)) {
      throw new Error(`overlay refuses to overwrite tracked path ${file}`);
    }
  }
  const overrides = opts.overrides ?? {};
  const defined = new Set<string>();
  const rewritten: Array<{ file: string; content: string }> = [];
  for (const file of files) {
    const content = await readFile(join(overlayDir, file), "utf8");
    for (const key of envKeys(content)) defined.add(key);
    const ported = opts.portRewrite === undefined ? content : rewritePorts(content, opts.portRewrite);
    rewritten.push({ file, content: applyOverrides(ported, overrides) });
  }
  // Checked before anything is written: a bad key must not leave the worktree half-overridden.
  const missing = Object.keys(overrides).filter((key) => !defined.has(key));
  if (missing.length > 0) throw new OverrideKeysError(missing);
  for (const { file, content } of rewritten) await writePrivate(join(worktreePath, file), content);
  return { copied: files };
};

/** The `slots.env` keys no overlay file defines; doctor reports them before a job fails on them. */
export const missingOverrideKeys = async (overlayDir: string, keys: string[]): Promise<string[]> => {
  const defined = new Set<string>();
  for (const file of await listFiles(overlayDir)) {
    for (const key of envKeys(await readFile(join(overlayDir, file), "utf8"))) defined.add(key);
  }
  return keys.filter((key) => !defined.has(key));
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
  // check-ignore exits 1 when nothing is ignored; anything above that (128 outside a repo) would otherwise read as "no files".
  if (result.exitCode > 1) throw new Error(`${checkoutPath} is not a git checkout: ${result.stderr}`);
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
