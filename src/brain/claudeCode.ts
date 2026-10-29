import { query, type HookCallback, type McpServerConfig, type Options, type SDKMessage, type SDKResultMessage, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { chatResultJsonSchema } from "../chat/result.js";
import { fixResultJsonSchema } from "../greptile/result.js";
import { implementResultJsonSchema } from "../implement/result.js";
import { evaluateTool, POLICY_HOOK_MATCHER } from "./policy.js";
import { STOPPED_ERROR, type Brain, type BrainControl, type BrainInput, type BrainOutput, type BrainUsage, type McpServerSpec, type OnMessage } from "./types.js";

const ALLOWED_TOOLS = ["Read", "Grep", "Glob", "Bash", "Edit", "Write", "MultiEdit", "WebFetch", "mcp__codehost__*", "mcp__playwright__*", "mcp__push__*", "mcp__orbit__*"];
const OUTPUT_SCHEMAS: Record<BrainOutput, Record<string, unknown>> = {
  implement: implementResultJsonSchema,
  fix: fixResultJsonSchema,
  chat: chatResultJsonSchema,
};
/** Claude Code deletes transcripts older than this; the steward's retention owns session deletion instead. */
export const CLEANUP_PERIOD_DAYS = 3650;
const FOLLOW_UP_PROMPT = "Stop investigating and emit the final structured result now.";

/** The SDK's `query`, narrowed to what the brain consumes so tests can substitute an async generator. */
export type QueryImpl = (p: { prompt: string | AsyncIterable<SDKUserMessage>; options: Options }) => AsyncIterable<SDKMessage> & { interrupt?: () => Promise<unknown> };

const userMessage = (text: string): SDKUserMessage => ({ type: "user", message: { role: "user", content: text }, parent_tool_use_id: null });

/**
 * The prompt as a stream: the first message, then each steered one, which the SDK delivers between turns. It ends when
 * the result arrives (messages queued by then are still delivered) or on stop; a message pushed after that is dropped.
 */
class PromptStream implements AsyncIterable<SDKUserMessage> {
  private readonly queued: SDKUserMessage[] = [];
  private wake: (() => void) | null = null;
  private ended = false;

  constructor(first: string) {
    this.push(first);
  }

  push(text: string): void {
    if (this.ended) return;
    this.queued.push(userMessage(text));
    this.wake?.();
  }

  end(): void {
    this.ended = true;
    this.wake?.();
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<SDKUserMessage> {
    for (;;) {
      const next = this.queued.shift();
      if (next !== undefined) {
        yield next;
        continue;
      }
      if (this.ended) return;
      await new Promise<void>((resolve) => {
        this.wake = resolve;
      });
      this.wake = null;
    }
  }
}

/** The query in flight: its prompt stream, for steering, and the query itself, for stop. */
interface ActiveQuery {
  prompt: PromptStream;
  interrupt: () => void;
}

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

/** One MCP server as Claude Code takes it, in the SDK's options and in the CLI's `--mcp-config`. */
export const claudeMcpServer = (spec: McpServerSpec): McpServerConfig =>
  spec.type === "http"
    ? { type: "http", url: spec.url, ...(spec.headers === undefined ? {} : { headers: spec.headers }) }
    : { type: "stdio", command: spec.command, args: spec.args, env: spec.env };

const mcpServers = (input: BrainInput): Record<string, McpServerConfig> =>
  Object.fromEntries(Object.entries(input.mcpServers).map(([name, spec]) => [name, claudeMcpServer(spec)]));

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

const consume = async (
  queryImpl: QueryImpl,
  text: string,
  options: Options,
  onMessage: OnMessage,
  setActive: (active: ActiveQuery | null) => void,
): Promise<SDKResultMessage | null> => {
  let result: SDKResultMessage | null = null;
  const prompt = new PromptStream(text);
  const running = queryImpl({ prompt, options });
  setActive({ prompt, interrupt: () => void running.interrupt?.().catch(() => undefined) });
  try {
    for await (const message of running) {
      onMessage(JSON.stringify(message));
      if (message.type === "result") {
        result = message;
        prompt.end();
      }
    }
  } catch (err) {
    if (result === null) throw err;
  } finally {
    prompt.end();
    setActive(null);
  }
  return result;
};

export const createClaudeCodeBrain = (deps: { queryImpl?: QueryImpl } = {}): Brain => {
  const queryImpl = deps.queryImpl ?? query;
  return {
    kind: "claude-code",
    run: async (input, onMessage, controlSink) => {
      let active: ActiveQuery | null = null;
      // A holder, not a `let`: the control handlers change it while the run awaits.
      const status: { state: "running" | "stopped" | "done" } = { state: "running" };
      const setActive = (next: ActiveQuery | null): void => {
        active = next;
      };
      const control: BrainControl = {
        steer: (message) => active?.prompt.push(message),
        stop: () => {
          if (status.state !== "running") return;
          status.state = "stopped";
          active?.prompt.end();
          active?.interrupt();
        },
      };
      controlSink?.(control);
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
        let result = await consume(queryImpl, input.prompt, options, onMessage, setActive);
        let usage = result === null ? undefined : usageOf(result);
        if (result?.subtype === "error_max_turns" && status.state === "running") {
          result = await consume(queryImpl, FOLLOW_UP_PROMPT, { ...options, resume: result.session_id, maxTurns: 2 }, onMessage, setActive);
          if (result !== null && usage !== undefined) usage = addUsage(usage, usageOf(result));
        }
        const reported = usage === undefined ? {} : { usage };
        if (status.state === "stopped") return { ok: false, output: undefined, ...reported, ...(result === null ? {} : { sessionId: result.session_id }), error: STOPPED_ERROR };
        if (result === null) return { ok: false, output: undefined, ...reported, error: "brain produced no result message" };
        const sessionId = result.session_id;
        if (result.subtype !== "success") return { ok: false, output: undefined, ...reported, sessionId, error: result.subtype };
        if (result.structured_output === undefined) {
          return { ok: false, output: undefined, ...reported, sessionId, error: "brain finished without structured output" };
        }
        return { ok: true, output: result.structured_output, ...reported, sessionId };
      } catch (err) {
        if (status.state === "stopped") return { ok: false, output: undefined, error: STOPPED_ERROR };
        return { ok: false, output: undefined, error: err instanceof Error ? err.message : String(err) };
      } finally {
        if (status.state === "running") status.state = "done";
        clearTimeout(timer);
      }
    },
  };
};
