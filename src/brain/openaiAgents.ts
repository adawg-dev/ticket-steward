import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { Agent, MCPServerStdio, run } from "@openai/agents";
import { ChatResultSchema } from "../chat/result.js";
import { FixResultSchema } from "../greptile/result.js";
import { ImplementResultSchema } from "../implement/result.js";
import { logger } from "../log.js";
import { createBrainTools } from "./tools/index.js";
import { BackgroundProcesses } from "./tools/processes.js";
import type { Brain, BrainInput, BrainUsage, ReasoningEffort } from "./types.js";

const INSTRUCTIONS =
  "You are Ticket Steward's analysis agent. You work in a disposable checkout of a monorepo: you may edit files and start the app there, but never commit, push, or touch files outside the worktree and artifacts directory. " +
  "run_shell has no shell, so pass a program and its arguments; `$STEWARD_PORT` and `$ARTIFACTS_DIR` are expanded for you. " +
  "Where a skill backgrounds a command (`cmd > log 2>&1 &`), use start_process, follow it with process_status, and stop it with stop_process when you are done. " +
  "Finish by returning the structured result.";

/** The browser tools a reproduction needs; each tool schema is resent on every turn, so the rest are left out. */
export const PLAYWRIGHT_TOOLS = [
  "browser_navigate",
  "browser_click",
  "browser_type",
  "browser_fill_form",
  "browser_press_key",
  "browser_select_option",
  "browser_hover",
  "browser_find",
  "browser_snapshot",
  "browser_take_screenshot",
  "browser_evaluate",
  "browser_wait_for",
  "browser_console_messages",
  "browser_network_requests",
  "browser_resize",
  "browser_close",
];

export const skillsText = async (workspacePath: string, names: string[] | undefined): Promise<string> => {
  const skillsDir = join(workspacePath, ".claude", "skills");
  const entries = await readdir(skillsDir, { withFileTypes: true }).catch(() => []);
  const sections = await Promise.all(
    entries
      .filter((e) => e.isDirectory() && (names === undefined || names.includes(e.name)))
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

/** The HTTP MCP servers of a run pod's tools sidecar; this brain runs only on the local runtime, with stdio servers. */
const httpServers = (input: BrainInput): string[] => Object.entries(input.mcpServers).flatMap(([name, spec]) => (spec.type === "http" ? [name] : []));

const mcpServers = (input: BrainInput): MCPServerStdio[] =>
  Object.entries(input.mcpServers).flatMap(([name, spec]) =>
    spec.type === "http"
      ? []
      : [
          new MCPServerStdio({
            name,
            command: spec.command,
            args: spec.args,
            env: spec.env,
            cwd: input.workspacePath,
            ...(name === "playwright" ? { toolFilter: { allowedToolNames: PLAYWRIGHT_TOOLS } } : {}),
          }),
        ],
  );

export const modelSettingsFor = (input: Pick<BrainInput, "reasoningEffort">): { reasoning?: { effort: ReasoningEffort } } =>
  input.reasoningEffort === undefined ? {} : { reasoning: { effort: input.reasoningEffort } };

const agentFor = <TOutput extends typeof ImplementResultSchema | typeof FixResultSchema | typeof ChatResultSchema>(
  input: BrainInput,
  servers: MCPServerStdio[],
  processes: BackgroundProcesses,
  outputType: TOutput,
) =>
  new Agent({
    name: "ticket-steward",
    instructions: INSTRUCTIONS,
    model: input.model,
    modelSettings: modelSettingsFor(input),
    tools: createBrainTools({
      workspacePath: input.workspacePath,
      artifactsDir: input.artifactsDir,
      denyPaths: input.denyPaths,
      processes,
      vars: { ARTIFACTS_DIR: input.artifactsDir, ...(input.env.STEWARD_PORT === undefined ? {} : { STEWARD_PORT: input.env.STEWARD_PORT }) },
    }),
    mcpServers: servers,
    outputType,
  });

export const createOpenAiAgentsBrain = (): Brain => ({
  kind: "openai-agents",
  run: async (input, onMessage, control) => {
    // This brain takes no input mid-run: steering and stop are logged and dropped (the Linear app requires claude-code).
    control?.({
      steer: () => logger.warn("openai-agents cannot be steered; message dropped"),
      stop: () => logger.warn("openai-agents cannot be stopped mid-run; stop ignored"),
    });
    if (input.resumeSessionId !== undefined) return { ok: false, output: undefined, error: "openai-agents cannot resume a session" };
    const http = httpServers(input);
    if (http.length > 0) return { ok: false, output: undefined, error: `openai-agents cannot reach HTTP MCP servers: ${http.join(", ")}` };
    const abortController = new AbortController();
    const timer = setTimeout(() => abortController.abort(), input.timeoutMs);
    const servers = mcpServers(input);
    const processes = new BackgroundProcesses(input.workspacePath, input.artifactsDir);
    try {
      await Promise.all(servers.map((s) => s.connect()));
      const agent =
        input.output === "implement"
          ? agentFor(input, servers, processes, ImplementResultSchema)
          : input.output === "fix"
            ? agentFor(input, servers, processes, FixResultSchema)
            : agentFor(input, servers, processes, ChatResultSchema);
      const prompt = `${input.prompt}${await skillsText(input.workspacePath, input.inlineSkills)}`;
      const result = await run(agent, prompt, { maxTurns: input.maxTurns, signal: abortController.signal });
      for (const item of result.newItems) onMessage(JSON.stringify(item.toJSON()));
      const usage = sumUsage(result);
      if (result.finalOutput === undefined) return { ok: false, output: undefined, usage, error: "agent finished without a final output" };
      return { ok: true, output: result.finalOutput, usage };
    } catch (err) {
      return { ok: false, output: undefined, error: err instanceof Error ? err.message : String(err) };
    } finally {
      clearTimeout(timer);
      await processes.stopAll().catch(() => undefined);
      await Promise.all(servers.map((s) => s.close().catch(() => undefined)));
    }
  },
});
