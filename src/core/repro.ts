import { chmod, copyFile, mkdir, realpath, stat } from "node:fs/promises";
import { dirname, isAbsolute, join, normalize, sep } from "node:path";
import type { BrainResult, Repro } from "./result.js";

export const REPRO_MAX_FILES = 20;
export const REPRO_MAX_BYTES = 1024 * 1024;

export const isBugTicket = (labels: string[], bugLabels: string[]): boolean => {
  const wanted = new Set(bugLabels.map((label) => label.trim().toLowerCase()));
  return labels.some((label) => wanted.has(label.trim().toLowerCase()));
};

/** Only bug tickets carry a reproduction (spec §2.4), whatever the brain returned. */
export const normalizeRepro = (result: BrainResult, isBug: boolean): BrainResult =>
  isBug || result.repro === null ? result : { ...result, repro: null };

export const reproFilesDir = (dataDir: string, jobId: number): string => join(dataDir, "repros", String(jobId));

const insideRelative = (file: string): string | null => {
  if (file.trim() === "" || isAbsolute(file)) return null;
  const clean = normalize(file);
  return clean === ".." || clean.startsWith(`..${sep}`) ? null : clean;
};

const refused = (file: string, why: string): string => `Recipe file \`${file}\` not saved: ${why}.`;

/** Copies the brain's recipe files out of the worktree before cleanup; refuses anything that is not a small regular file inside it. */
export const captureReproFiles = async (worktreePath: string, files: string[], destDir: string): Promise<{ saved: string[]; notes: string[] }> => {
  const root = await realpath(worktreePath);
  const saved: string[] = [];
  const notes: string[] = [];
  for (const file of files) {
    if (saved.length >= REPRO_MAX_FILES) {
      notes.push(refused(file, `more than ${REPRO_MAX_FILES} files`));
      continue;
    }
    const relative = insideRelative(file);
    if (relative === null) {
      notes.push(refused(file, "the path must stay inside the workspace"));
      continue;
    }
    let source: string;
    try {
      source = await realpath(join(root, relative));
    } catch {
      notes.push(refused(file, "file not found"));
      continue;
    }
    if (!source.startsWith(root + sep)) {
      notes.push(refused(file, "the path must stay inside the workspace"));
      continue;
    }
    const info = await stat(source);
    if (!info.isFile()) {
      notes.push(refused(file, "not a regular file"));
      continue;
    }
    if (info.size > REPRO_MAX_BYTES) {
      notes.push(refused(file, "larger than 1 MB"));
      continue;
    }
    const target = join(destDir, relative);
    await mkdir(dirname(target), { recursive: true, mode: 0o700 });
    await copyFile(source, target);
    await chmod(target, 0o600);
    saved.push(relative);
  }
  return { saved, notes };
};

/** Puts saved recipe files back at their workspace paths so a replay uses the exact same files. */
export const restoreReproFiles = async (filesDir: string, files: string[], worktreePath: string): Promise<string[]> => {
  const restored: string[] = [];
  for (const file of files) {
    const relative = insideRelative(file);
    if (relative === null) continue;
    const target = join(worktreePath, relative);
    await mkdir(dirname(target), { recursive: true });
    await copyFile(join(filesDir, relative), target);
    restored.push(relative);
  }
  return restored;
};

const shellFence = (command: string): string => {
  const fence = command.includes("```") ? "~~~" : "```";
  return `${fence}sh\n${command}\n${fence}`;
};

export const renderReproMarkdown = (repro: Repro): string => {
  const lines = ["### Reproduction", "", `**Status:** ${repro.status === "reproduced" ? "reproduced" : "not reproduced"} · **Method:** ${repro.method}`];
  if (repro.command !== null) lines.push("", "**Command** (from the workspace root):", "", shellFence(repro.command));
  if (repro.steps.length > 0) lines.push("", "**Steps:**", "", ...repro.steps.map((step, index) => `${index + 1}. ${step}`));
  lines.push("", `**Expected:** ${repro.expected}`, "", `**Observed:** ${repro.observed}`);
  if (repro.files.length > 0) lines.push("", `**Recipe files:** ${repro.files.map((file) => `\`${file}\``).join(", ")}`);
  return lines.join("\n");
};
