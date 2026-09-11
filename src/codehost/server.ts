import { homedir } from "node:os";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import type { McpServerSpec } from "../brain/types.js";
import type { Secrets } from "../config/load.js";
import { recentCommits } from "./gitlog.js";
import type { CodeHost } from "./types.js";

const DEFAULT_SINCE_DAYS = 30;

const RecentChangesInput = z.object({
  paths: z.array(z.string()).describe("Repository-relative paths (files or directories) to inspect"),
  since_days: z.number().int().positive().optional().describe("Look back this many days (default 30)"),
});

const PermalinkInput = z.object({
  path: z.string().describe("Repository-relative file path"),
  line: z.number().int().positive().optional().describe("Line number to anchor"),
});

export const startCodeHostMcpServer = async (p: { codehost: CodeHost; worktreePath: string; sha: string }): Promise<void> => {
  const server = new McpServer({ name: "ticket-steward-codehost", version: "0.1.0" });

  server.registerTool(
    "recent_changes",
    {
      description: "Commits that touched the given paths recently, resolved to their merge requests / pull requests",
      inputSchema: RecentChangesInput,
    },
    async ({ paths, since_days }) => {
      const commits = await recentCommits(p.worktreePath, paths, since_days ?? DEFAULT_SINCE_DAYS);
      const changes = await p.codehost.changesForCommits(commits.map((c) => c.sha));
      return { content: [{ type: "text", text: JSON.stringify(changes) }] };
    },
  );

  server.registerTool(
    "permalink",
    { description: "Permanent code-host link to a file (and line) at the checked-out commit", inputSchema: PermalinkInput },
    async ({ path, line }) => ({ content: [{ type: "text", text: p.codehost.permalink(path, p.sha, line) }] }),
  );

  await server.connect(new StdioServerTransport());
};

export const codehostMcpSpec = (p: {
  binPath: string;
  configPath: string;
  worktreePath: string;
  sha: string;
  secrets: Secrets;
}): McpServerSpec => {
  const env: Record<string, string> = { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? homedir() };
  if (p.secrets.GITLAB_TOKEN !== undefined) env.GITLAB_TOKEN = p.secrets.GITLAB_TOKEN;
  if (p.secrets.GITHUB_TOKEN !== undefined) env.GITHUB_TOKEN = p.secrets.GITHUB_TOKEN;
  return {
    command: process.execPath,
    args: [p.binPath, "mcp", "codehost", "--config", p.configPath, "--workspace", p.worktreePath, "--sha", p.sha],
    env,
  };
};
