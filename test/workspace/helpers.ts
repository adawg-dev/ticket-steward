import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { execa } from "execa";

import { gitEnvRecord } from "../../src/workspace/git.js";

export const tmpDir = (): Promise<string> => mkdtemp(join(tmpdir(), "steward-test-"));

export const removeDir = (dir: string): Promise<void> => rm(dir, { recursive: true, force: true });

const gitIdentity = ["-c", "user.name=Test", "-c", "user.email=test@example.com"];

export const git = async (cwd: string, args: string[]): Promise<string> => {
  const { stdout } = await execa("git", [...gitIdentity, ...args], { cwd, env: gitEnvRecord(), extendEnv: false });
  return stdout.trim();
};

export const commitFile = async (repo: string, file: string, content: string): Promise<string> => {
  const full = join(repo, file);
  await mkdir(dirname(full), { recursive: true });
  await writeFile(full, content);
  await git(repo, ["add", "--", file]);
  await git(repo, ["commit", "-q", "-m", `add ${file}`]);
  return git(repo, ["rev-parse", "HEAD"]);
};

export const makeSourceRepo = async (root: string): Promise<{ repo: string; sha: string }> => {
  const repo = join(root, "source");
  await mkdir(repo);
  await git(repo, ["init", "-q", "-b", "main"]);
  const sha = await commitFile(repo, "README.md", "hello\n");
  return { repo, sha };
};
