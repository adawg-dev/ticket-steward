import { homedir } from "node:os";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import type { McpServerSpec } from "../brain/types.js";
import type { Secrets } from "../config/load.js";
import type { CodeHostConfig } from "../config/schema.js";
import { orbitEnv, type OrbitExec } from "./run.js";

export const ORBIT_TOOL_TIMEOUT_MS = 60_000;
export const ORBIT_OUTPUT_BYTES = 64 * 1024;
const REASON_CHARS = 2_000;

const QueryInput = z.object({ query: z.string().min(1).describe("An openCypher query (MATCH ... RETURN) over the GitLab Knowledge Graph") });
const ContextInput = z.object({
  refs: z
    .array(z.string().min(1))
    .min(1)
    .describe("GitLab targets as `glab orbit context` takes them: mr:42, issue:7, pipeline:123, job:456, commit:<sha>, branch:<name>, a GitLab URL, or repo:group/project before them"),
});

export type ToolText = { content: Array<{ type: "text"; text: string }>; isError?: boolean };

/**
 * What the server runs Orbit with: the worktree as cwd and, for the remote API, `GITLAB_TOKEN` in the child's env only.
 * `unavailable` names why remote calls cannot work at all (no token, not a GitLab code host); every tool then says so.
 */
export interface OrbitRemote {
  exec: OrbitExec;
  cwd: string;
  env: Record<string, string>;
  unavailable?: string;
  /** Values masked out of anything returned, in case Orbit ever echoes them. */
  secrets: string[];
}

/** The remote's env and reason it is unavailable, from the config's code host and `.env`. */
export const orbitRemote = (p: { exec: OrbitExec; dataDir: string; worktreePath: string; codehost: CodeHostConfig; secrets: Secrets }): OrbitRemote => {
  const base: OrbitRemote = { exec: p.exec, cwd: p.worktreePath, env: orbitEnv(p.dataDir), secrets: [] };
  if (p.codehost.kind !== "gitlab") return { ...base, unavailable: "the code host is not GitLab" };
  const token = p.secrets.GITLAB_TOKEN;
  if (token === undefined || token === "") return { ...base, unavailable: "GITLAB_TOKEN is not set" };
  return { ...base, env: { ...base.env, GITLAB_TOKEN: token, GITLAB_URL: p.codehost.baseUrl }, secrets: [token] };
};

const mask = (text: string, secrets: string[]): string => secrets.reduce((out, secret) => out.split(secret).join("***"), text);

const truncate = (text: string): string => {
  const bytes = Buffer.from(text, "utf8");
  if (bytes.length <= ORBIT_OUTPUT_BYTES) return text;
  return `${bytes.subarray(0, ORBIT_OUTPUT_BYTES).toString("utf8")}\n[output truncated at ${ORBIT_OUTPUT_BYTES} bytes; narrow the query]`;
};

const unavailable = (reason: string): ToolText => ({ content: [{ type: "text", text: `Orbit remote is unavailable: ${reason}` }], isError: true });

/** Runs one Orbit command for a tool call. Any failure is an error result naming the reason; it never throws. */
export const runOrbitTool = async (remote: OrbitRemote, args: string[]): Promise<ToolText> => {
  if (remote.unavailable !== undefined) return unavailable(remote.unavailable);
  try {
    const run = await remote.exec(args, { cwd: remote.cwd, env: remote.env, timeoutMs: ORBIT_TOOL_TIMEOUT_MS });
    if (run.timedOut) return unavailable(`timed out after ${ORBIT_TOOL_TIMEOUT_MS / 1000} s`);
    if (run.exitCode !== 0) {
      const detail = (run.stderr.trim() || run.stdout.trim() || `orbit exited ${run.exitCode ?? "without a code"}`).slice(0, REASON_CHARS);
      return unavailable(mask(detail, remote.secrets));
    }
    return { content: [{ type: "text", text: truncate(mask(run.stdout, remote.secrets)) }] };
  } catch (err) {
    return unavailable(mask(err instanceof Error ? err.message : String(err), remote.secrets));
  }
};

/** A ref that is a URL on another host than the code host; Orbit would send the token wherever a URL ref points. */
export const foreignRef = (refs: string[], baseUrl: string | undefined): string | undefined =>
  refs.find((ref) => {
    if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(ref)) return false;
    if (baseUrl === undefined) return true;
    try {
      return new URL(ref).origin !== new URL(baseUrl).origin;
    } catch {
      return true;
    }
  });

/** orbit_context: refs that point off the code host are refused before Orbit (and the token) sees them. */
export const runOrbitContext = (remote: OrbitRemote, refs: string[]): Promise<ToolText> => {
  const foreign = foreignRef(refs, remote.env.GITLAB_URL);
  if (foreign !== undefined) return Promise.resolve(unavailable(`${foreign} is not on the configured GitLab host`));
  return runOrbitTool(remote, ["context", "--", ...refs]);
};

/** Serves read-only Orbit tools. `--` keeps a query or ref from being read as an Orbit flag. */
export const startOrbitMcpServer = async (remote: OrbitRemote): Promise<void> => {
  const server = new McpServer({ name: "ticket-steward-orbit", version: "0.1.0" });

  server.registerTool(
    "orbit_query",
    {
      description:
        "Run a read-only openCypher query against the GitLab Knowledge Graph (merge requests, pipelines, jobs, issues, projects and how they relate). Call orbit_schema first for node types and properties.",
      inputSchema: QueryInput,
    },
    async ({ query }) => runOrbitTool(remote, ["query", "--", query]),
  );

  server.registerTool(
    "orbit_schema",
    { description: "The GitLab Knowledge Graph schema: node types, properties and edges", inputSchema: z.object({}) },
    async () => runOrbitTool(remote, ["schema"]),
  );

  server.registerTool(
    "orbit_context",
    {
      description:
        "Read GitLab entities with what they cite: merge requests (description, threads, changed files, failed jobs), issues, pipelines, job logs, commits. For code in the worktree, run `orbit context` in the shell instead.",
      inputSchema: ContextInput,
    },
    async ({ refs }) => runOrbitContext(remote, refs),
  );

  await server.connect(new StdioServerTransport());
};

/**
 * Spawn spec for `steward mcp orbit`. Like `codehostMcpSpec`, the env carries no secrets: the server loads `GITLAB_TOKEN`
 * itself from the config's `.env` and hands it only to the Orbit processes it runs.
 */
export const orbitMcpSpec = (p: { binPath: string; configPath: string; worktreePath: string }): McpServerSpec => ({
  command: process.execPath,
  args: [p.binPath, "mcp", "orbit", "--config", p.configPath, "--workspace", p.worktreePath],
  env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? homedir() },
});
