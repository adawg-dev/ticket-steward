import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execa } from "execa";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { codehostMcpSpec } from "../../src/codehost/server.js";

const gitEnv = {
  GIT_AUTHOR_NAME: "Ada",
  GIT_AUTHOR_EMAIL: "ada@example.com",
  GIT_COMMITTER_NAME: "Ada",
  GIT_COMMITTER_EMAIL: "ada@example.com",
  GIT_CONFIG_GLOBAL: "/dev/null",
};

const git = (cwd: string, args: string[]) => execa("git", args, { cwd, env: gitEnv });

const repoWithOneCommit = async () => {
  const dir = await mkdtemp(join(tmpdir(), "steward-mcp-"));
  await git(dir, ["init", "-q", "-b", "main"]);
  await writeFile(join(dir, "a.ts"), "a\n");
  await git(dir, ["add", "a.ts"]);
  await git(dir, ["commit", "-q", "-m", "touch a"]);
  const { stdout } = await git(dir, ["rev-parse", "HEAD"]);
  return { dir, sha: stdout.trim() };
};

const tsxBin = resolve("node_modules/tsx/dist/cli.mjs");
const entry = resolve("test/codehost/fakeServerEntry.ts");

const connect = async (worktreePath: string, sha: string) => {
  const client = new Client({ name: "steward-test", version: "0.0.0" });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [tsxBin, entry, worktreePath, sha],
    env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "" },
    stderr: "pipe",
  });
  await client.connect(transport);
  return client;
};

beforeEach(() => {
  vi.restoreAllMocks();
});

describe("codehost MCP server", () => {
  it("lists recent_changes and permalink tools", async () => {
    const { dir, sha } = await repoWithOneCommit();
    const client = await connect(dir, sha);

    const { tools } = await client.listTools();

    expect(tools.length).toBe(2);
    expect(tools[0]?.name).toBe("recent_changes");
    expect(tools[1]?.name).toBe("permalink");
    await client.close();
  });

  it("recent_changes returns the commit that touched the path", async () => {
    const { dir, sha } = await repoWithOneCommit();
    const client = await connect(dir, sha);

    const result = await client.callTool({ name: "recent_changes", arguments: { paths: ["a.ts"] } });

    const [first] = result.content as Array<{ type: "text"; text: string }>;
    expect(first?.type).toBe("text");
    expect(JSON.parse(first?.text ?? "")).toEqual([
      {
        kind: "commit",
        id: sha,
        title: `commit ${sha}`,
        url: `https://fake.example/commit/${sha}`,
        author: "Fake",
        at: "2026-09-01T00:00:00Z",
        shas: [sha],
      },
    ]);
    await client.close();
  });

  it("permalink uses the server's sha", async () => {
    const { dir, sha } = await repoWithOneCommit();
    const client = await connect(dir, sha);

    const result = await client.callTool({ name: "permalink", arguments: { path: "a.ts", line: 3 } });

    const [first] = result.content as Array<{ type: "text"; text: string }>;
    expect(first?.text).toBe(`https://fake.example/blob/${sha}/a.ts#L3`);
    await client.close();
  });
});

describe("codehostMcpSpec", () => {
  it("spawns steward over node with only PATH, HOME and the codehost token in env", () => {
    const spec = codehostMcpSpec({
      binPath: "/opt/steward/bin/steward.js",
      configPath: "/etc/ticket-steward/steward.config.ts",
      worktreePath: "/var/lib/ticket-steward/work/1-1",
      sha: "abc123",
      secrets: { GITLAB_TOKEN: "glpat-secret", LINEAR_CLIENT_SECRET: "never", MIRROR_TOKEN: "never" },
    });

    expect(spec.command).toBe(process.execPath);
    expect(spec.args).toEqual([
      "/opt/steward/bin/steward.js",
      "mcp",
      "codehost",
      "--config",
      "/etc/ticket-steward/steward.config.ts",
      "--workspace",
      "/var/lib/ticket-steward/work/1-1",
      "--sha",
      "abc123",
    ]);
    expect(Object.keys(spec.env).sort()).toEqual(["GITLAB_TOKEN", "HOME", "PATH"]);
    expect(spec.env.GITLAB_TOKEN).toBe("glpat-secret");
  });

  it("passes GITHUB_TOKEN when that is the configured codehost secret", () => {
    const spec = codehostMcpSpec({
      binPath: "/opt/steward/bin/steward.js",
      configPath: "/etc/ticket-steward/steward.config.ts",
      worktreePath: "/var/lib/ticket-steward/work/1-1",
      sha: "abc123",
      secrets: { GITHUB_TOKEN: "ghp_secret" },
    });

    expect(Object.keys(spec.env).sort()).toEqual(["GITHUB_TOKEN", "HOME", "PATH"]);
  });
});
