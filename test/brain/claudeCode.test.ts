import type { SDKResultMessage } from "@anthropic-ai/claude-agent-sdk";
import { createClaudeCodeBrain, type QueryImpl } from "../../src/brain/claudeCode.js";
import type { BrainInput } from "../../src/brain/types.js";

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
};

const usage = { inputTokens: 10, outputTokens: 20, costUsd: 0.5 };

/** Only the fields the brain reads; the SDK type carries dozens more. */
const resultMessage = (fields: { subtype: SDKResultMessage["subtype"]; structured_output?: unknown }): SDKResultMessage =>
  ({ type: "result", session_id: "sess-1", total_cost_usd: 0.5, usage: { input_tokens: 10, output_tokens: 20 }, ...fields }) as unknown as SDKResultMessage;

const yielding =
  (...messages: SDKResultMessage[]): QueryImpl =>
  async function* () {
    for (const message of messages) yield message;
  };

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

    expect(run).toEqual({ ok: true, output: { summary: "done" }, usage });
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
    expect(run.usage).toEqual(usage);
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
});
