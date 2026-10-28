import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { errorMessage } from "../core/workspace.js";
import type { PushResult } from "./service.js";

export { pushMcpSpec } from "./target.js";

const PushInput = z.object({
  branchType: z.string().optional().describe("The branch type for the first push of a new branch, one of the types the task names"),
  note: z.string().optional().describe("A short note on what this push contains"),
});

export type PushRequest = z.infer<typeof PushInput>;

/** The tool's text: the result as JSON, and an error result for a refusal so the agent fixes the cause and calls again. */
const toolResult = (result: PushResult): { content: Array<{ type: "text"; text: string }>; isError?: boolean } => ({
  content: [{ type: "text", text: JSON.stringify(result) }],
  ...(result.ok ? {} : { isError: true }),
});

export type PushTool = (request: PushRequest) => Promise<PushResult>;

export const PUSH_SERVER_INFO = { name: "ticket-steward-push", version: "0.1.0" };

/**
 * One push at a time: a second call waits for the first, so two pushes never race on the branch or the record. A thrown
 * error is a refusal the agent sees. Wrap once per run, so every transport and session shares the queue.
 */
export const serialPushes = (push: PushTool): PushTool => {
  let queue: Promise<unknown> = Promise.resolve();
  return (request) => {
    const run = queue.then(() => push(request).catch((err: unknown): PushResult => ({ ok: false, reason: "push failed", detail: errorMessage(err) })));
    queue = run;
    return run;
  };
};

/** Registers the `push` tool on `server`, whatever its transport; `push` should come from `serialPushes`. */
export const registerPushTool = (server: McpServer, push: PushTool): void => {
  server.registerTool(
    "push",
    {
      description:
        "Push your commits (HEAD) to this ticket's branch. Commit first; every commit subject must start with the ticket identifier and a colon. The steward checks the commits, runs its checks and pushes; a refusal says what to fix before calling again.",
      inputSchema: PushInput,
    },
    async (request) => toolResult(await push(request)),
  );
};

/** Serves the `push` tool over stdio, one push at a time. */
export const startPushMcpServer = async (p: { push: PushTool }): Promise<void> => {
  const server = new McpServer(PUSH_SERVER_INFO);
  registerPushTool(server, serialPushes(p.push));
  await server.connect(new StdioServerTransport());
};
