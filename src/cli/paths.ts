import { join } from "node:path";
import { fileURLToPath } from "node:url";

/** The package root, two directories above src/cli or dist/cli. */
export const packageRoot = fileURLToPath(new URL("../../", import.meta.url));

export const binPath = join(packageRoot, "bin", "steward.js");

export const defaultPromptPath = join(packageRoot, "prompts", "enrich.md");

export const envExamplePath = join(packageRoot, ".env.example");

export const mirrorPath = (dataDir: string): string => join(dataDir, "repo.git");

export const jobsDir = (dataDir: string): string => join(dataDir, "jobs");

export const workRoot = (dataDir: string): string => join(dataDir, "work");

export const artifactsDir = (dataDir: string, jobId: number | string): string => join(jobsDir(dataDir), String(jobId), "artifacts");
