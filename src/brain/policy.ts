import { homedir } from "node:os";
import { isAbsolute, relative, resolve } from "node:path";

export type PolicyDecision = { allow: true } | { allow: false; reason: string };

const WRITE_TOOLS = new Set(["Edit", "Write", "MultiEdit", "write_file"]);
const READ_TOOLS = new Set(["Read", "Glob", "Grep", "read_file", "list_dir"]);
const SHELL_TOOLS = new Set(["Bash", "run_shell"]);
const ALLOWED_MCP_PREFIXES = ["mcp__codehost__", "mcp__playwright__"];
const DENIED_COMMANDS: RegExp[] = [
  /git\s+push/,
  /git\s+commit/,
  /git\s+remote/,
  /git\s+worktree/,
  /git\s+gc/,
  /git\s+update-ref/,
  /git\s+config/,
  /curl[^\n]*api\.linear\.app/,
];

/** Whitespace, shell operators and quotes; parentheses are kept so `$(pwd)/..` stays one unresolvable token. */
const SHELL_SEPARATORS = /[\s;|&<>`"']+/;
const HOME_PREFIX = /^(~|\$HOME|\$\{HOME\})(?=\/|$)/;
const PWD_PREFIX = /^(\$PWD|\$\{PWD\})(?=\/|$)/;

const allow: PolicyDecision = { allow: true };
const deny = (reason: string): PolicyDecision => ({ allow: false, reason });

const isUnder = (path: string, root: string): boolean => {
  const rel = relative(root, path);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
};

const asRecord = (input: unknown): Record<string, unknown> =>
  typeof input === "object" && input !== null ? (input as Record<string, unknown>) : {};

const stringField = (record: Record<string, unknown>, key: string): string | undefined => {
  const value = record[key];
  return typeof value === "string" ? value : undefined;
};

const commandText = (input: unknown): string => {
  const record = asRecord(input);
  const command = stringField(record, "command") ?? "";
  const args = Array.isArray(record.args) ? record.args.filter((a): a is string => typeof a === "string") : [];
  return [command, ...args].join(" ");
};

const targetPath = (input: unknown): string | undefined => {
  const record = asRecord(input);
  return stringField(record, "file_path") ?? stringField(record, "path");
};

const looksLikePath = (token: string): boolean => token.includes("/") || token.includes("..") || HOME_PREFIX.test(token);

/** Absolute form of a command token, or null when it starts with a shell variable we cannot expand. */
const resolveToken = (token: string, workspacePath: string): string | null => {
  const expanded = token.replace(HOME_PREFIX, homedir()).replace(PWD_PREFIX, workspacePath);
  return expanded.startsWith("$") ? null : resolve(workspacePath, expanded);
};

const deniedPathIn = (resolved: string, denyPaths: string[]): string | undefined => denyPaths.find((d) => isUnder(resolved, d));

const checkCommandPaths = (text: string, workspacePath: string, denyPaths: string[]): PolicyDecision => {
  for (const token of text.split(SHELL_SEPARATORS).filter(looksLikePath)) {
    const resolved = resolveToken(token, workspacePath);
    if (resolved === null) return deny(`cannot resolve path ${token}`);
    const denied = deniedPathIn(resolved, denyPaths);
    if (denied !== undefined) return deny(`command references denied path ${denied}`);
  }
  return allow;
};

export const evaluateTool = (p: {
  name: string;
  input: unknown;
  workspacePath: string;
  artifactsDir: string;
  denyPaths: string[];
}): PolicyDecision => {
  if (WRITE_TOOLS.has(p.name)) {
    const target = targetPath(p.input);
    if (target === undefined) return deny(`${p.name} requires a file path`);
    const resolved = resolve(p.workspacePath, target);
    const denied = deniedPathIn(resolved, p.denyPaths);
    if (denied !== undefined) return deny(`${resolved} is under denied path ${denied}`);
    if (isUnder(resolved, p.workspacePath) || isUnder(resolved, p.artifactsDir)) return allow;
    return deny(`${resolved} is outside the worktree and artifacts directory`);
  }
  if (READ_TOOLS.has(p.name)) {
    const target = targetPath(p.input);
    if (target === undefined) return allow;
    const resolved = resolve(p.workspacePath, target);
    const denied = deniedPathIn(resolved, p.denyPaths);
    return denied === undefined ? allow : deny(`${resolved} is under denied path ${denied}`);
  }
  if (SHELL_TOOLS.has(p.name)) {
    const text = commandText(p.input);
    const pattern = DENIED_COMMANDS.find((re) => re.test(text));
    if (pattern !== undefined) return deny(`command matches denied pattern ${pattern.source}`);
    return checkCommandPaths(text, p.workspacePath, p.denyPaths);
  }
  if (p.name.startsWith("mcp__")) {
    const permitted = ALLOWED_MCP_PREFIXES.some((prefix) => p.name.startsWith(prefix));
    return permitted ? allow : deny(`MCP tool ${p.name} is not permitted`);
  }
  return allow;
};
