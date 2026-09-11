import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { Agent, MCPServerStdio, run } from "@openai/agents";
import { BrainResultSchema } from "../core/result.js";
import { createBrainTools } from "./tools/index.js";
import type { Brain, BrainInput, BrainUsage } from "./types.js";

const INSTRUCTIONS =
  "You are Ticket Steward's analysis agent. You work inside a read-only checkout of a monorepo and never commit, push, or touch files outside the worktree and artifacts directory. Finish by returning the structured result.";

const skillsText = async (workspacePath: string): Promise<string> => {
  const skillsDir = join(workspacePath, ".claude", "skills");
  const entries = await readdir(skillsDir, { withFileTypes: true }).catch(() => []);
  const sections = await Promise.all(
    entries
      .filter((e) => e.isDirectory())
      .map(async (e) => {
        const body = await readFile(join(skillsDir, e.name, "SKILL.md"), "utf8").catch(() => null);
        return body === null ? "" : `\n\n## Skill: ${e.name}\n\n${body}`;
      }),
  );
  return sections.join("");
};

const sumUsage = (result: { rawResponses: Array<{ usage: { inputTokens: number; outputTokens: number } }> }): BrainUsage =>
  result.rawResponses.reduce(
    (acc, r) => ({ inputTokens: acc.inputTokens + r.usage.inputTokens, outputTokens: acc.outputTokens + r.usage.outputTokens }),
    { inputTokens: 0, outputTokens: 0 },
  );

const mcpServers = (input: BrainInput): MCPServerStdio[] =>
  Object.entries(input.mcpServers).map(([name, spec]) => new MCPServerStdio({ name, command: spec.command, args: spec.args, env: spec.env, cwd: input.workspacePath }));

export const createOpenAiAgentsBrain = (): Brain => ({
  kind: "openai-agents",
  run: async (input, onMessage) => {
    const abortController = new AbortController();
    const timer = setTimeout(() => abortController.abort(), input.timeoutMs);
    const servers = mcpServers(input);
    try {
      await Promise.all(servers.map((s) => s.connect()));
      const agent = new Agent({
        name: "ticket-steward",
        instructions: INSTRUCTIONS,
        model: input.model,
        tools: createBrainTools({ workspacePath: input.workspacePath, artifactsDir: input.artifactsDir, denyPaths: input.denyPaths }),
        mcpServers: servers,
        outputType: BrainResultSchema,
      });
      const prompt = `${input.prompt}${await skillsText(input.workspacePath)}`;
      const result = await run(agent, prompt, { maxTurns: input.maxTurns, signal: abortController.signal });
      for (const item of result.newItems) onMessage(JSON.stringify(item.toJSON()));
      const usage = sumUsage(result);
      if (result.finalOutput === undefined) return { ok: false, output: undefined, usage, error: "agent finished without a final output" };
      return { ok: true, output: result.finalOutput, usage };
    } catch (err) {
      return { ok: false, output: undefined, error: err instanceof Error ? err.message : String(err) };
    } finally {
      clearTimeout(timer);
      await Promise.all(servers.map((s) => s.close().catch(() => undefined)));
    }
  },
});
