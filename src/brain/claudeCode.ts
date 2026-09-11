import { query, type HookCallback, type McpServerConfig, type Options, type SDKResultMessage } from "@anthropic-ai/claude-agent-sdk";
import { brainResultJsonSchema } from "../core/result.js";
import { evaluateTool } from "./policy.js";
import type { Brain, BrainInput, BrainUsage, OnMessage } from "./types.js";

const ALLOWED_TOOLS = ["Read", "Grep", "Glob", "Bash", "Edit", "Write", "MultiEdit", "WebFetch", "mcp__codehost__*", "mcp__playwright__*"];
const FOLLOW_UP_PROMPT = "Stop investigating and emit the final structured result now.";

const policyHook = (input: BrainInput): HookCallback => async (hookInput) => {
  if (hookInput.hook_event_name !== "PreToolUse") return {};
  const decision = evaluateTool({
    name: hookInput.tool_name,
    input: hookInput.tool_input,
    workspacePath: input.workspacePath,
    artifactsDir: input.artifactsDir,
    denyPaths: input.denyPaths,
  });
  if (decision.allow) return {};
  return {
    hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: decision.reason },
  };
};

const mcpServers = (input: BrainInput): Record<string, McpServerConfig> =>
  Object.fromEntries(Object.entries(input.mcpServers).map(([name, spec]) => [name, { type: "stdio", command: spec.command, args: spec.args, env: spec.env }]));

const usageOf = (result: SDKResultMessage): BrainUsage => ({
  inputTokens: result.usage.input_tokens,
  outputTokens: result.usage.output_tokens,
  costUsd: result.total_cost_usd,
});

const consume = async (prompt: string, options: Options, onMessage: OnMessage): Promise<SDKResultMessage | null> => {
  let result: SDKResultMessage | null = null;
  try {
    for await (const message of query({ prompt, options })) {
      onMessage(JSON.stringify(message));
      if (message.type === "result") result = message;
    }
  } catch (err) {
    if (result === null) throw err;
  }
  return result;
};

export const createClaudeCodeBrain = (): Brain => ({
  kind: "claude-code",
  run: async (input, onMessage) => {
    const abortController = new AbortController();
    const timer = setTimeout(() => abortController.abort(), input.timeoutMs);
    const options: Options = {
      cwd: input.workspacePath,
      maxTurns: input.maxTurns,
      model: input.model,
      permissionMode: "acceptEdits",
      allowedTools: ALLOWED_TOOLS,
      settingSources: ["project"],
      mcpServers: mcpServers(input),
      outputFormat: { type: "json_schema", schema: brainResultJsonSchema },
      hooks: { PreToolUse: [{ matcher: "Bash|Edit|Write|MultiEdit", hooks: [policyHook(input)] }] },
      abortController,
    };
    try {
      let result = await consume(input.prompt, options, onMessage);
      if (result?.subtype === "error_max_turns") {
        result = await consume(FOLLOW_UP_PROMPT, { ...options, resume: result.session_id, maxTurns: 2 }, onMessage);
      }
      if (result === null) return { ok: false, output: undefined, error: "brain produced no result message" };
      if (result.subtype !== "success") return { ok: false, output: undefined, usage: usageOf(result), error: result.subtype };
      if (result.structured_output === undefined) {
        return { ok: false, output: undefined, usage: usageOf(result), error: "brain finished without structured output" };
      }
      return { ok: true, output: result.structured_output, usage: usageOf(result) };
    } catch (err) {
      return { ok: false, output: undefined, error: err instanceof Error ? err.message : String(err) };
    } finally {
      clearTimeout(timer);
    }
  },
});
