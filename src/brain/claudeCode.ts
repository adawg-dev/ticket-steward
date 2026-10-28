import { query, type HookCallback, type McpServerConfig, type Options, type SDKMessage, type SDKResultMessage } from "@anthropic-ai/claude-agent-sdk";
import { fixResultJsonSchema } from "../greptile/result.js";
import { implementResultJsonSchema } from "../implement/result.js";
import { evaluateTool } from "./policy.js";
import type { Brain, BrainInput, BrainOutput, BrainUsage, OnMessage } from "./types.js";

const ALLOWED_TOOLS = ["Read", "Grep", "Glob", "Bash", "Edit", "Write", "MultiEdit", "WebFetch", "mcp__codehost__*", "mcp__playwright__*"];
const POLICY_HOOK_MATCHER = "Bash|Edit|Write|MultiEdit|Read|Glob|Grep";
const OUTPUT_SCHEMAS: Record<BrainOutput, Record<string, unknown>> = {
  implement: implementResultJsonSchema,
  fix: fixResultJsonSchema,
};
/** Claude Code deletes transcripts older than this; the steward's retention owns session deletion instead. */
const CLEANUP_PERIOD_DAYS = 3650;
const FOLLOW_UP_PROMPT = "Stop investigating and emit the final structured result now.";

/** The SDK's `query`, narrowed to what the brain consumes so tests can substitute an async generator. */
export type QueryImpl = (p: { prompt: string; options: Options }) => AsyncIterable<SDKMessage>;

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

const addUsage = (a: BrainUsage, b: BrainUsage): BrainUsage => ({
  inputTokens: a.inputTokens + b.inputTokens,
  outputTokens: a.outputTokens + b.outputTokens,
  ...(a.costUsd === undefined && b.costUsd === undefined ? {} : { costUsd: (a.costUsd ?? 0) + (b.costUsd ?? 0) }),
});

const consume = async (queryImpl: QueryImpl, prompt: string, options: Options, onMessage: OnMessage): Promise<SDKResultMessage | null> => {
  let result: SDKResultMessage | null = null;
  try {
    for await (const message of queryImpl({ prompt, options })) {
      onMessage(JSON.stringify(message));
      if (message.type === "result") result = message;
    }
  } catch (err) {
    if (result === null) throw err;
  }
  return result;
};

export const createClaudeCodeBrain = (deps: { queryImpl?: QueryImpl } = {}): Brain => {
  const queryImpl = deps.queryImpl ?? query;
  return {
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
        settings: { cleanupPeriodDays: CLEANUP_PERIOD_DAYS },
        mcpServers: mcpServers(input),
        outputFormat: { type: "json_schema", schema: OUTPUT_SCHEMAS[input.output] },
        hooks: { PreToolUse: [{ matcher: POLICY_HOOK_MATCHER, hooks: [policyHook(input)] }] },
        abortController,
        ...(input.resumeSessionId === undefined ? {} : { resume: input.resumeSessionId }),
      };
      try {
        let result = await consume(queryImpl, input.prompt, options, onMessage);
        let usage = result === null ? undefined : usageOf(result);
        if (result?.subtype === "error_max_turns") {
          result = await consume(queryImpl, FOLLOW_UP_PROMPT, { ...options, resume: result.session_id, maxTurns: 2 }, onMessage);
          if (result !== null && usage !== undefined) usage = addUsage(usage, usageOf(result));
        }
        const reported = usage === undefined ? {} : { usage };
        if (result === null) return { ok: false, output: undefined, ...reported, error: "brain produced no result message" };
        const sessionId = result.session_id;
        if (result.subtype !== "success") return { ok: false, output: undefined, ...reported, sessionId, error: result.subtype };
        if (result.structured_output === undefined) {
          return { ok: false, output: undefined, ...reported, sessionId, error: "brain finished without structured output" };
        }
        return { ok: true, output: result.structured_output, ...reported, sessionId };
      } catch (err) {
        return { ok: false, output: undefined, error: err instanceof Error ? err.message : String(err) };
      } finally {
        clearTimeout(timer);
      }
    },
  };
};
