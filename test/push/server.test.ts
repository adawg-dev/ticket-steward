import { resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { pushMcpSpec } from "../../src/push/server.js";
import type { PushTarget } from "../../src/push/target.js";

const tsxBin = resolve("node_modules/tsx/dist/cli.mjs");
const entry = resolve("test/push/fakeServerEntry.ts");

const connect = async (): Promise<Client> => {
  const client = new Client({ name: "steward-test", version: "0.0.0" });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [tsxBin, entry],
    env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "" },
    stderr: "pipe",
  });
  await client.connect(transport);
  return client;
};

type ToolText = { content: Array<{ type: "text"; text: string }>; isError?: boolean };

const call = async (client: Client, args: Record<string, string>): Promise<{ result: unknown; isError: boolean }> => {
  const { content, isError } = (await client.callTool({ name: "push", arguments: args })) as ToolText;
  return { result: JSON.parse(content[0]?.text ?? ""), isError: isError === true };
};

describe("push MCP server", () => {
  it("lists only the push tool", async () => {
    const client = await connect();
    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name)).toEqual(["push"]);
    await client.close();
  });

  it("returns a push as text", async () => {
    const client = await connect();
    expect(await call(client, { branchType: "feature", note: "first" })).toEqual({
      result: { ok: true, branch: "feature/API-1-x", sha: "a".repeat(40), commits: 2 },
      isError: false,
    });
    await client.close();
  });

  it("returns a refusal as an error result the agent can act on", async () => {
    const client = await connect();
    expect(await call(client, { branchType: "refuse" })).toEqual({
      result: { ok: false, reason: "commit or discard your changes first", detail: "notes.md" },
      isError: true,
    });
    await client.close();
  });

  it("turns a thrown error into a refusal and keeps serving", async () => {
    const client = await connect();
    expect(await call(client, { branchType: "throw" })).toEqual({ result: { ok: false, reason: "push failed", detail: "git exploded" }, isError: true });
    expect((await call(client, {})).isError).toBe(false);
    await client.close();
  });

  it("runs one push at a time", async () => {
    const client = await connect();
    const results = await Promise.all([call(client, {}), call(client, {})]);
    expect(results.map(({ isError }) => isError)).toEqual([false, false]);
    await client.close();
  });
});

describe("pushMcpSpec", () => {
  it("spawns steward mcp push with the target on the command line and only PATH and HOME in env", () => {
    const target: PushTarget = {
      jobId: 7,
      worktreePath: "/var/lib/ticket-steward/work/ticket-API-1",
      identifier: "API-1",
      issueId: "issue-1",
      mode: "create",
      branch: null,
      baseSha: "b".repeat(40),
      loopId: null,
      port: 4100,
    };

    const spec = pushMcpSpec({ binPath: "/opt/steward/bin/steward.js", configPath: "/etc/ticket-steward/steward.config.ts", target });

    expect(spec.command).toBe(process.execPath);
    expect(spec.args).toEqual(["/opt/steward/bin/steward.js", "mcp", "push", "--config", "/etc/ticket-steward/steward.config.ts", "--target", JSON.stringify(target)]);
    expect(Object.keys(spec.env).sort()).toEqual(["HOME", "PATH"]);
  });
});
