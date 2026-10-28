import { join } from "node:path";
import { fileURLToPath } from "node:url";

/** The package root, two directories above src/cli or dist/cli. */
export const packageRoot = fileURLToPath(new URL("../../", import.meta.url));

export const binPath = join(packageRoot, "bin", "steward.js");

export const implementPromptPath = join(packageRoot, "prompts", "implement.md");

export const fixPromptPath = join(packageRoot, "prompts", "fix.md");

/** The chat prompt is the steward's own, not a config file: chat has no prompt setting. */
export const chatPromptPath = join(packageRoot, "prompts", "chat.md");
export const envExamplePath = join(packageRoot, ".env.example");

export const mirrorPath = (dataDir: string): string => join(dataDir, "repo.git");

export const jobsDir = (dataDir: string): string => join(dataDir, "jobs");

export const workRoot = (dataDir: string): string => join(dataDir, "work");

export const artifactsDir = (dataDir: string, jobId: number | string): string => join(jobsDir(dataDir), String(jobId), "artifacts");
