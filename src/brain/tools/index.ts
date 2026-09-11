import { readdir, readFile, mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { tool, type Tool } from "@openai/agents";
import { execa } from "execa";
import { z } from "zod";
import { evaluateTool } from "../policy.js";

export interface ToolContext {
  workspacePath: string;
  artifactsDir: string;
  denyPaths: string[];
}

const MAX_OUTPUT_CHARS = 100_000;
const SHELL_TIMEOUT_MS = 120_000;

const capped = (text: string): string => (text.length > MAX_OUTPUT_CHARS ? `${text.slice(0, MAX_OUTPUT_CHARS)}\n[truncated]` : text);

const guard = (ctx: ToolContext, name: string, input: unknown): string | null => {
  const decision = evaluateTool({ name, input, workspacePath: ctx.workspacePath, artifactsDir: ctx.artifactsDir, denyPaths: ctx.denyPaths });
  return decision.allow ? null : `Denied: ${decision.reason}`;
};

export const createBrainTools = (ctx: ToolContext): Tool[] => [
  tool({
    name: "read_file",
    description: "Read a UTF-8 text file. Paths are relative to the worktree root.",
    parameters: z.object({ path: z.string() }),
    execute: async (input) => {
      const denied = guard(ctx, "read_file", input);
      if (denied !== null) return denied;
      return capped(await readFile(resolve(ctx.workspacePath, input.path), "utf8"));
    },
  }),
  tool({
    name: "grep_repo",
    description: "Search tracked files in the worktree with git grep. Returns path:line:text matches.",
    parameters: z.object({ pattern: z.string(), path: z.string().nullable() }),
    execute: async (input) => {
      const denied = guard(ctx, "grep_repo", input);
      if (denied !== null) return denied;
      const args = ["grep", "-n", "-I", "-e", input.pattern, "--", ...(input.path === null ? [] : [input.path])];
      const { stdout } = await execa("git", args, { cwd: ctx.workspacePath, reject: false });
      return capped(stdout);
    },
  }),
  tool({
    name: "list_dir",
    description: "List entries of a directory relative to the worktree root. Directories end with '/'.",
    parameters: z.object({ path: z.string() }),
    execute: async (input) => {
      const denied = guard(ctx, "list_dir", input);
      if (denied !== null) return denied;
      const entries = await readdir(resolve(ctx.workspacePath, input.path), { withFileTypes: true });
      return entries.map((e) => (e.isDirectory() ? `${e.name}/` : e.name)).join("\n");
    },
  }),
  tool({
    name: "run_shell",
    description: "Run a program with arguments inside the worktree (no shell). Returns exit code, stdout and stderr.",
    parameters: z.object({ command: z.string(), args: z.array(z.string()) }),
    execute: async (input) => {
      const denied = guard(ctx, "run_shell", input);
      if (denied !== null) return denied;
      const result = await execa(input.command, input.args, { cwd: ctx.workspacePath, shell: false, reject: false, timeout: SHELL_TIMEOUT_MS });
      return capped(`exit ${result.exitCode ?? "signal"}\n--- stdout ---\n${result.stdout}\n--- stderr ---\n${result.stderr}`);
    },
  }),
  tool({
    name: "write_file",
    description: "Write a UTF-8 text file inside the worktree or the artifacts directory.",
    parameters: z.object({ path: z.string(), content: z.string() }),
    execute: async (input) => {
      const denied = guard(ctx, "write_file", input);
      if (denied !== null) return denied;
      const target = resolve(ctx.workspacePath, input.path);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, input.content, "utf8");
      return `wrote ${target}`;
    },
  }),
];
