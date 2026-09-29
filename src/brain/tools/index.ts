import { readdir, readFile, mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { tool, type Tool } from "@openai/agents";
import { execa } from "execa";
import { z } from "zod";
import { evaluateTool } from "../policy.js";
import { type BackgroundProcesses, expandVars } from "./processes.js";

export interface ToolContext {
  workspacePath: string;
  artifactsDir: string;
  denyPaths: string[];
  processes: BackgroundProcesses;
  /** Expanded as `$NAME` / `${NAME}` in command arguments, since there is no shell to do it (STEWARD_PORT, ARTIFACTS_DIR). */
  vars: Record<string, string>;
}

const MAX_OUTPUT_CHARS = 100_000;
const SHELL_TIMEOUT_MS = 120_000;

const capped = (text: string): string => (text.length > MAX_OUTPUT_CHARS ? `${text.slice(0, MAX_OUTPUT_CHARS)}\n[truncated]` : text);

const expandCommand = (ctx: ToolContext, input: { command: string; args: string[] }): { command: string; args: string[] } => ({
  command: expandVars(input.command, ctx.vars),
  args: input.args.map((arg) => expandVars(arg, ctx.vars)),
});

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
    description:
      "Run a program with arguments inside the worktree (no shell, so no pipes, redirection or `&`) and wait up to 2 minutes for it to exit. Returns exit code, stdout and stderr. For a dev server or anything long-lived, use start_process.",
    parameters: z.object({ command: z.string(), args: z.array(z.string()) }),
    execute: async (raw) => {
      const input = expandCommand(ctx, raw);
      const denied = guard(ctx, "run_shell", input);
      if (denied !== null) return denied;
      const result = await execa(input.command, input.args, { cwd: ctx.workspacePath, shell: false, reject: false, timeout: SHELL_TIMEOUT_MS });
      return capped(`exit ${result.exitCode ?? "signal"}\n--- stdout ---\n${result.stdout}\n--- stderr ---\n${result.stderr}`);
    },
  }),
  tool({
    name: "start_process",
    description:
      "Start a long-lived program (e.g. a dev server) in the background from the worktree root, without a shell. Output goes to <artifacts>/<name>.log. It keeps running until stop_process or the end of the run. Use this for a skill's `cmd > log 2>&1 &`.",
    parameters: z.object({ name: z.string(), command: z.string(), args: z.array(z.string()) }),
    execute: async (raw) => {
      const input = { name: raw.name, ...expandCommand(ctx, raw) };
      const denied = guard(ctx, "start_process", input);
      if (denied !== null) return denied;
      try {
        const { pid, logPath } = await ctx.processes.start(input.name, input.command, input.args);
        return `started ${input.name} (pid ${pid}); log: ${logPath}`;
      } catch (err) {
        return `Failed: ${err instanceof Error ? err.message : String(err)}`;
      }
    },
  }),
  tool({
    name: "process_status",
    description: "Whether a process from start_process is still running, and the last 80 lines of its log.",
    parameters: z.object({ name: z.string() }),
    execute: async (input) => capped(await ctx.processes.status(input.name)),
  }),
  tool({
    name: "stop_process",
    description: "Stop a process from start_process and everything it started. Always stop the servers you started once you are done with them.",
    parameters: z.object({ name: z.string() }),
    execute: async (input) => ctx.processes.stop(input.name),
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
