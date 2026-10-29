import type { SDKMessage, SDKResultMessage, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { createClaudeCodeBrain, type QueryImpl } from "../../src/brain/claudeCode.js";
import { STOPPED_ERROR, type BrainControl, type BrainInput } from "../../src/brain/types.js";
import { fixResultJsonSchema } from "../../src/greptile/result.js";
import { implementResultJsonSchema } from "../../src/implement/result.js";

const input: BrainInput = {
  workspacePath: "/data/work/42-1",
  artifactsDir: "/data/jobs/42/artifacts",
  transcriptPath: "/data/jobs/42/attempt-1.jsonl",
  prompt: "investigate",
  env: {},
  timeoutMs: 10_000,
  maxTurns: 12,
  model: "claude-test",
  mcpServers: {},
  denyPaths: [],
  output: "fix",
};

const usage = { inputTokens: 10, outputTokens: 20, costUsd: 0.5 };

/** Only the fields the brain reads; the SDK type carries dozens more. */
const resultMessage = (fields: {
  subtype: SDKResultMessage["subtype"];
  structured_output?: unknown;
  session_id?: string;
  total_cost_usd?: number;
  usage?: { input_tokens: number; output_tokens: number };
  user_message_uuids?: string[];
}): SDKResultMessage =>
  ({ type: "result", session_id: "sess-1", total_cost_usd: 0.5, usage: { input_tokens: 10, output_tokens: 20 }, ...fields }) as unknown as SDKResultMessage;

const yielding =
  (...messages: SDKResultMessage[]): QueryImpl =>
  async function* () {
    for (const message of messages) yield message;
  };

const assistantText = (text: string): SDKMessage =>
  ({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text }] }, parent_tool_use_id: null, session_id: "sess-1" }) as unknown as SDKMessage;

const textOf = (message: SDKUserMessage): unknown => message.message.content;

/**
 * Like the SDK in streaming-input mode: one turn per user message it pulls, until the input ends. A result echoes the
 * uuid it answered, as current CLIs do, unless `echo` is false, as older ones do.
 */
const streaming =
  (received: SDKUserMessage[], echo = true): QueryImpl =>
  ({ prompt }) =>
    (async function* () {
      if (typeof prompt === "string") throw new Error("expected a streamed prompt");
      for await (const message of prompt) {
        received.push(message);
        yield assistantText(`working on turn ${received.length}`);
        const uuids = echo && message.uuid !== undefined ? { user_message_uuids: [message.uuid] } : {};
        yield resultMessage({ subtype: "success", structured_output: { summary: `turn ${received.length}` }, ...uuids });
      }
    })();

const uuidsOf = (messages: SDKUserMessage[]): string[] => messages.flatMap((message) => (message.uuid === undefined ? [] : [message.uuid]));

/**
 * Like the CLI when a steered message reaches it mid-turn: it takes the message off stdin before turn 1's result and runs
 * it as turn 2, or with `fold` folds it into turn 1. Records how many results it had produced when the input ended.
 */
const steeredMidTurn =
  (received: SDKUserMessage[], ended: { afterResults: number | null }, fold: boolean): QueryImpl =>
  ({ prompt }) =>
    (async function* () {
      if (typeof prompt === "string") throw new Error("expected a streamed prompt");
      const input = prompt[Symbol.asyncIterator]();
      let results = 0;
      const pull = async (): Promise<SDKUserMessage | null> => {
        const next = await input.next();
        if (next.done === true) {
          ended.afterResults ??= results;
          return null;
        }
        received.push(next.value);
        return next.value;
      };
      await pull();
      yield assistantText("working on turn 1");
      await pull();
      results += 1;
      yield resultMessage({ subtype: "success", structured_output: { summary: "turn 1" }, user_message_uuids: uuidsOf(fold ? received : received.slice(0, 1)) });
      if (!fold) {
        yield assistantText("working on turn 2");
        results += 1;
        yield resultMessage({ subtype: "success", structured_output: { summary: "turn 2" }, user_message_uuids: uuidsOf(received.slice(1)) });
      }
      // The SDK keeps reading input until it ends; a turn is still running while it is open.
      await pull();
    })();

const lines: string[] = [];
const onMessage = (line: string): void => {
  lines.push(line);
};

describe("claude-code brain", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    lines.length = 0;
  });

  it("issues exactly one follow-up query resuming the session when the first run hits max turns", async () => {
    const queryMock = vi
      .fn<QueryImpl>()
      .mockImplementationOnce(yielding(resultMessage({ subtype: "error_max_turns" })))
      .mockImplementationOnce(yielding(resultMessage({ subtype: "success", structured_output: { summary: "done" } })));

    const run = await createClaudeCodeBrain({ queryImpl: queryMock }).run(input, onMessage);

    expect(run).toEqual({ ok: true, output: { summary: "done" }, usage: { inputTokens: 20, outputTokens: 40, costUsd: 1 }, sessionId: "sess-1" });
    expect(queryMock).toHaveBeenCalledTimes(2);
    expect(queryMock.mock.calls[0]?.[0].options.maxTurns).toBe(12);
    expect(queryMock.mock.calls[0]?.[0].options.resume).toBeUndefined();
    expect(queryMock.mock.calls[1]?.[0].options.resume).toBe("sess-1");
    expect(queryMock.mock.calls[1]?.[0].options.maxTurns).toBe(2);
    expect(lines.length).toBe(2);
  });

  it("gives up after a second max-turns result instead of following up again", async () => {
    const queryMock = vi.fn<QueryImpl>().mockImplementation(yielding(resultMessage({ subtype: "error_max_turns" })));

    const run = await createClaudeCodeBrain({ queryImpl: queryMock }).run(input, onMessage);

    expect(run.ok).toBe(false);
    expect(run.output).toBeUndefined();
    expect(run.usage).toEqual({ inputTokens: 20, outputTokens: 40, costUsd: 1 });
    expect(queryMock).toHaveBeenCalledTimes(2);
  });

  it("treats a success without structured output as a failed run", async () => {
    const queryMock = vi.fn<QueryImpl>().mockImplementation(yielding(resultMessage({ subtype: "success" })));

    const run = await createClaudeCodeBrain({ queryImpl: queryMock }).run(input, onMessage);

    expect(run.ok).toBe(false);
    expect(run.output).toBeUndefined();
    expect(run.usage).toEqual(usage);
    expect(queryMock).toHaveBeenCalledTimes(1);
  });

  it("reports usage on an execution error result", async () => {
    const queryMock = vi.fn<QueryImpl>().mockImplementation(yielding(resultMessage({ subtype: "error_during_execution" })));

    const run = await createClaudeCodeBrain({ queryImpl: queryMock }).run(input, onMessage);

    expect(run.ok).toBe(false);
    expect(run.output).toBeUndefined();
    expect(run.usage).toEqual(usage);
    expect(queryMock).toHaveBeenCalledTimes(1);
  });

  it("asks for the fix schema when the input is a fix", async () => {
    const queryMock = vi.fn<QueryImpl>().mockImplementation(yielding(resultMessage({ subtype: "success", structured_output: { summary: "done" } })));

    await createClaudeCodeBrain({ queryImpl: queryMock }).run(input, onMessage);

    const captured = queryMock.mock.calls[0]?.[0].options;
    expect(captured?.outputFormat).toEqual({ type: "json_schema", schema: fixResultJsonSchema });
  });

  it("asks for the implement schema when the input is an implement", async () => {
    const queryMock = vi.fn<QueryImpl>().mockImplementation(yielding(resultMessage({ subtype: "success", structured_output: { summary: "done" } })));

    await createClaudeCodeBrain({ queryImpl: queryMock }).run({ ...input, output: "implement" }, onMessage);

    const captured = queryMock.mock.calls[0]?.[0].options;
    expect(captured?.outputFormat).toEqual({ type: "json_schema", schema: implementResultJsonSchema });
  });

  it("returns the SDK session id of a successful run", async () => {
    const queryMock = vi
      .fn<QueryImpl>()
      .mockImplementation(
        yielding(resultMessage({ subtype: "success", structured_output: {}, session_id: "s1", usage: { input_tokens: 10, output_tokens: 2 }, total_cost_usd: 0.5 })),
      );

    const run = await createClaudeCodeBrain({ queryImpl: queryMock }).run(input, onMessage);

    expect(run.sessionId).toBe("s1");
    expect(run.usage).toEqual({ inputTokens: 10, outputTokens: 2, costUsd: 0.5 });
  });

  it("resumes the given session", async () => {
    const queryMock = vi.fn<QueryImpl>().mockImplementation(yielding(resultMessage({ subtype: "success", structured_output: {} })));

    await createClaudeCodeBrain({ queryImpl: queryMock }).run({ ...input, resumeSessionId: "s0" }, onMessage);

    expect(queryMock.mock.calls[0]?.[0].options.resume).toBe("s0");
  });

  it("keeps sessions past Claude Code's own transcript cleanup", async () => {
    const queryMock = vi.fn<QueryImpl>().mockImplementation(yielding(resultMessage({ subtype: "success", structured_output: {} })));

    await createClaudeCodeBrain({ queryImpl: queryMock }).run(input, onMessage);

    expect(queryMock.mock.calls[0]?.[0].options.settings).toEqual({ cleanupPeriodDays: 3650 });
  });

  it("sums usage over the max-turns follow-up and returns the follow-up's session id", async () => {
    const queryMock = vi
      .fn<QueryImpl>()
      .mockImplementationOnce(
        yielding(resultMessage({ subtype: "error_max_turns", session_id: "s1", usage: { input_tokens: 10, output_tokens: 2 }, total_cost_usd: 0.5 })),
      )
      .mockImplementationOnce(
        yielding(resultMessage({ subtype: "success", structured_output: {}, session_id: "s2", usage: { input_tokens: 3, output_tokens: 1 }, total_cost_usd: 0.1 })),
      );

    const run = await createClaudeCodeBrain({ queryImpl: queryMock }).run(input, onMessage);

    expect(run.usage?.inputTokens).toBe(13);
    expect(run.usage?.outputTokens).toBe(3);
    expect(run.usage?.costUsd).toBeCloseTo(0.6);
    expect(run.sessionId).toBe("s2");
  });

  it("passes stdio and HTTP MCP servers through to the SDK", async () => {
    const queryMock = vi.fn<QueryImpl>().mockImplementation(yielding(resultMessage({ subtype: "success", structured_output: {} })));
    const servers: BrainInput["mcpServers"] = {
      playwright: { command: "/usr/bin/node", args: ["mcp.js"], env: { HOME: "/home/steward" } },
      push: { type: "http", url: "http://127.0.0.1:4181/mcp/push" },
      codehost: { type: "http", url: "http://127.0.0.1:4181/mcp/codehost", headers: { "x-run": "7-1" } },
    };

    await createClaudeCodeBrain({ queryImpl: queryMock }).run({ ...input, mcpServers: servers }, onMessage);

    expect(queryMock.mock.calls[0]?.[0].options.mcpServers).toEqual({
      playwright: { type: "stdio", command: "/usr/bin/node", args: ["mcp.js"], env: { HOME: "/home/steward" } },
      push: { type: "http", url: "http://127.0.0.1:4181/mcp/push" },
      codehost: { type: "http", url: "http://127.0.0.1:4181/mcp/codehost", headers: { "x-run": "7-1" } },
    });
  });

  it("streams the prompt and delivers a steered message as the next user message", async () => {
    const received: SDKUserMessage[] = [];
    let control: BrainControl | undefined;
    const steerOnFirstTurn = (line: string): void => {
      if (line.includes("working on turn 1")) control?.steer("use v2");
    };

    const run = await createClaudeCodeBrain({ queryImpl: streaming(received) }).run(input, steerOnFirstTurn, (handlers) => {
      control = handlers;
    });

    expect(received.map(textOf)).toEqual(["investigate", "use v2"]);
    expect(received[0]).toMatchObject({ type: "user", parent_tool_use_id: null, message: { role: "user" } });
    expect(run).toMatchObject({ ok: true, output: { summary: "turn 2" } });
  });

  it("ends the input when the result arrives, so a later steer is not delivered", async () => {
    const received: SDKUserMessage[] = [];
    let control: BrainControl | undefined;

    const run = await createClaudeCodeBrain({ queryImpl: streaming(received) }).run(input, onMessage, (handlers) => {
      control = handlers;
    });
    control?.steer("too late");

    expect(received.map(textOf)).toEqual(["investigate"]);
    expect(run).toMatchObject({ ok: true, output: { summary: "turn 1" } });
  });

  it("interrupts the query on stop and reports the run as stopped, without a max-turns follow-up", async () => {
    let interrupted!: () => void;
    const interruptedNow = new Promise<void>((resolve) => {
      interrupted = resolve;
    });
    const interrupt = vi.fn(async () => {
      interrupted();
      return undefined;
    });
    const queryMock = vi.fn<QueryImpl>().mockImplementation(({ prompt }) => {
      const messages = (async function* () {
        if (typeof prompt !== "string") await prompt[Symbol.asyncIterator]().next();
        yield assistantText("editing");
        await interruptedNow;
        yield resultMessage({ subtype: "error_max_turns", session_id: "s-stopped" });
      })();
      return Object.assign(messages, { interrupt });
    });
    let control: BrainControl | undefined;
    const stopWhileWorking = (line: string): void => {
      if (line.includes("editing")) control?.stop();
    };

    const run = await createClaudeCodeBrain({ queryImpl: queryMock }).run(input, stopWhileWorking, (handlers) => {
      control = handlers;
    });

    expect(interrupt).toHaveBeenCalledTimes(1);
    expect(queryMock).toHaveBeenCalledTimes(1);
    expect(run).toEqual({ ok: false, output: undefined, usage, sessionId: "s-stopped", error: STOPPED_ERROR });
  });

  it("ends the input after an older CLI's result that echoes no uuids", async () => {
    const received: SDKUserMessage[] = [];

    const run = await createClaudeCodeBrain({ queryImpl: streaming(received, false) }).run(input, onMessage);

    expect(received.map(textOf)).toEqual(["investigate"]);
    expect(run).toMatchObject({ ok: true, output: { summary: "turn 1" } });
  });

  it("keeps the input open while a steered message the CLI already took has not been answered", async () => {
    const received: SDKUserMessage[] = [];
    const ended: { afterResults: number | null } = { afterResults: null };
    let control: BrainControl | undefined;
    const steerOnFirstTurn = (line: string): void => {
      if (line.includes("working on turn 1")) control?.steer("use v2");
    };

    const run = await createClaudeCodeBrain({ queryImpl: steeredMidTurn(received, ended, false) }).run(input, steerOnFirstTurn, (handlers) => {
      control = handlers;
    });

    expect(received.map(textOf)).toEqual(["investigate", "use v2"]);
    expect(ended.afterResults).toBe(2);
    expect(run).toMatchObject({ ok: true, output: { summary: "turn 2" } });
  });

  it("ends the input on the result of a turn the steered message was folded into", async () => {
    const received: SDKUserMessage[] = [];
    const ended: { afterResults: number | null } = { afterResults: null };
    let control: BrainControl | undefined;
    const steerOnFirstTurn = (line: string): void => {
      if (line.includes("working on turn 1")) control?.steer("use v2");
    };

    const run = await createClaudeCodeBrain({ queryImpl: steeredMidTurn(received, ended, true) }).run(input, steerOnFirstTurn, (handlers) => {
      control = handlers;
    });

    expect(ended.afterResults).toBe(1);
    expect(run).toMatchObject({ ok: true, output: { summary: "turn 1" } });
  });

  it("delivers a steer sent through the control sink before the query exists after the first prompt", async () => {
    const received: SDKUserMessage[] = [];

    const run = await createClaudeCodeBrain({ queryImpl: streaming(received) }).run(input, onMessage, (handlers) => {
      handlers.steer("use v2");
    });

    expect(received.map(textOf)).toEqual(["investigate", "use v2"]);
    expect(run).toMatchObject({ ok: true, output: { summary: "turn 2" } });
  });

  it("delivers a steer sent between the max-turns result and the follow-up to the follow-up", async () => {
    const received: SDKUserMessage[] = [];
    let control: BrainControl | undefined;
    const queryMock = vi
      .fn<QueryImpl>()
      .mockImplementationOnce(({ prompt }) =>
        (async function* () {
          if (typeof prompt === "string") throw new Error("expected a streamed prompt");
          const first = await prompt[Symbol.asyncIterator]().next();
          const uuid = first.done === true ? undefined : first.value.uuid;
          yield resultMessage({ subtype: "error_max_turns", ...(uuid === undefined ? {} : { user_message_uuids: [uuid] }) });
        })(),
      )
      .mockImplementationOnce(streaming(received));
    const steerOnMaxTurns = (line: string): void => {
      if (line.includes("error_max_turns")) control?.steer("use v2");
    };

    const run = await createClaudeCodeBrain({ queryImpl: queryMock }).run(input, steerOnMaxTurns, (handlers) => {
      control = handlers;
    });

    expect(received.map(textOf)).toEqual(["Stop investigating and emit the final structured result now.", "use v2"]);
    expect(run).toMatchObject({ ok: true, output: { summary: "turn 2" } });
  });

  it("skips the query when a stop arrives through the control sink before it exists", async () => {
    const queryMock = vi.fn<QueryImpl>().mockImplementation(yielding(resultMessage({ subtype: "success", structured_output: {} })));

    const run = await createClaudeCodeBrain({ queryImpl: queryMock }).run(input, onMessage, (handlers) => {
      handlers.steer("use v2");
      handlers.stop();
    });

    expect(queryMock).not.toHaveBeenCalled();
    expect(run).toEqual({ ok: false, output: undefined, error: STOPPED_ERROR });
  });
});
