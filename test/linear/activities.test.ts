import { describe, expect, it } from "vitest";
import { createBrainLineMapper, panelScrub, type PanelEvent } from "../../src/linear/activities.js";

const WORKTREE = "/var/lib/steward/worktrees/API-1";
const identity = (text: string): string => text;

const assistant = (content: unknown[]): string =>
  JSON.stringify({
    type: "assistant",
    message: { id: "msg_1", type: "message", role: "assistant", model: "claude-test", content, stop_reason: null, usage: {} },
    parent_tool_use_id: null,
    uuid: "u-1",
    session_id: "s-1",
  });

const toolResult = (toolUseId: string, content: unknown, isError = false): string =>
  JSON.stringify({
    type: "user",
    message: { role: "user", content: [{ type: "tool_result", tool_use_id: toolUseId, content, is_error: isError }] },
    parent_tool_use_id: null,
    uuid: "u-2",
    session_id: "s-1",
  });

const toolUse = (id: string, name: string, input: unknown): string => assistant([{ type: "tool_use", id, name, input }]);

const mapper = (scrub: (text: string) => string = identity) => createBrainLineMapper({ scrub, workspacePath: WORKTREE });

describe("createBrainLineMapper", () => {
  it("maps assistant text to one thought, joining adjacent text blocks", () => {
    const map = mapper();
    expect(map(assistant([{ type: "text", text: "Reading the ticket." }, { type: "text", text: "Then the tests." }]))).toEqual([
      { activity: { type: "thought", body: "Reading the ticket.\n\nThen the tests." }, ephemeral: false },
    ]);
  });

  it("keeps the order of text and tool calls in one message and skips thinking blocks", () => {
    const map = mapper();
    const events = map(
      assistant([
        { type: "thinking", thinking: "private", signature: "x" },
        { type: "text", text: "Running the tests." },
        { type: "tool_use", id: "t1", name: "Bash", input: { command: "pnpm test" } },
        { type: "text", text: "  " },
      ]),
    );
    expect(events).toEqual([
      { activity: { type: "thought", body: "Running the tests." }, ephemeral: false },
      { activity: { type: "action", action: "Running", parameter: "pnpm test" }, ephemeral: true },
    ]);
  });

  it("maps a Bash call to an ephemeral Running action with the command's first line, at most 80 chars", () => {
    const map = mapper();
    expect(map(toolUse("t1", "Bash", { command: "pnpm test", description: "Run tests" }))).toEqual([
      { activity: { type: "action", action: "Running", parameter: "pnpm test" }, ephemeral: true },
    ]);
    const long = `echo ${"x".repeat(200)}\nsecond line`;
    const [event] = map(toolUse("t2", "Bash", { command: long }));
    expect(event).toBeDefined();
    const parameter = event !== undefined && "activity" in event && event.activity.type === "action" ? event.activity.parameter : "";
    expect(parameter.length).toBeLessThanOrEqual(80);
    expect(parameter).not.toContain("second line");
  });

  it("names each tool kind and shows edited paths relative to the worktree", () => {
    const map = mapper();
    const actions = [
      toolUse("a", "Edit", { file_path: `${WORKTREE}/src/x.ts`, old_string: "SECRET OLD", new_string: "SECRET NEW" }),
      toolUse("b", "Write", { file_path: `${WORKTREE}/docs/a.md`, content: "file body" }),
      toolUse("c", "MultiEdit", { file_path: "/elsewhere/y.ts", edits: [] }),
      toolUse("d", "Read", { file_path: `${WORKTREE}/src/secret.ts` }),
      toolUse("e", "Grep", { pattern: "password" }),
      toolUse("f", "Glob", { pattern: "**/*.env" }),
      toolUse("g", "mcp__push__push", { message: "feat: x" }),
      toolUse("h", "mcp__playwright__browser_navigate", { url: "http://localhost:4100/admin?token=abc" }),
      toolUse("i", "mcp__orbit__grep", { query: "x" }),
    ].flatMap((line) => map(line));
    expect(actions).toEqual([
      { activity: { type: "action", action: "Editing", parameter: "src/x.ts" }, ephemeral: true },
      { activity: { type: "action", action: "Editing", parameter: "docs/a.md" }, ephemeral: true },
      { activity: { type: "action", action: "Editing", parameter: "/elsewhere/y.ts" }, ephemeral: true },
      { activity: { type: "action", action: "Reading", parameter: "" }, ephemeral: true },
      { activity: { type: "action", action: "Searching", parameter: "" }, ephemeral: true },
      { activity: { type: "action", action: "Searching", parameter: "" }, ephemeral: true },
      { activity: { type: "action", action: "Pushing", parameter: "" }, ephemeral: true },
      { activity: { type: "action", action: "Browsing", parameter: "" }, ephemeral: true },
      { activity: { type: "action", action: "mcp__orbit__grep", parameter: "" }, ephemeral: true },
    ]);
  });

  it("reports edit, write, command and push results as ok or failed, and nothing for reads", () => {
    const map = mapper();
    map(toolUse("t1", "Bash", { command: "pnpm test" }));
    map(toolUse("t2", "Edit", { file_path: `${WORKTREE}/src/x.ts`, old_string: "a", new_string: "b" }));
    map(toolUse("t3", "Read", { file_path: `${WORKTREE}/src/x.ts` }));
    map(toolUse("t4", "mcp__push__push", { message: "x" }));
    expect(map(toolResult("t1", "FAIL src/x.test.ts\nexit code 1", true))).toEqual([
      { activity: { type: "action", action: "Running", parameter: "pnpm test", result: "failed" }, ephemeral: false },
    ]);
    expect(map(toolResult("t2", [{ type: "text", text: "The file was updated" }]))).toEqual([
      { activity: { type: "action", action: "Editing", parameter: "src/x.ts", result: "ok" }, ephemeral: false },
    ]);
    expect(map(toolResult("t3", "export const secret = 1;"))).toEqual([]);
    expect(map(toolResult("t4", '{"ok":true}'))).toEqual([
      { activity: { type: "action", action: "Pushing", parameter: "", result: "ok" }, ephemeral: false },
    ]);
    expect(map(toolResult("unknown", "x"))).toEqual([]);
  });

  it("never puts tool output or tool input beyond the parameter into any event", () => {
    const map = mapper();
    const lines = [
      toolUse("t1", "Bash", { command: "cat .env", description: "DESCRIPTION_MARKER" }),
      toolResult("t1", "OUTPUT_MARKER_1"),
      toolUse("t2", "Edit", { file_path: `${WORKTREE}/a.ts`, old_string: "INPUT_MARKER_OLD", new_string: "INPUT_MARKER_NEW" }),
      toolResult("t2", [{ type: "text", text: "OUTPUT_MARKER_2" }]),
      toolUse("t3", "Read", { file_path: `${WORKTREE}/a.ts` }),
      toolResult("t3", "OUTPUT_MARKER_3"),
      toolUse("t4", "Bash", { command: "false" }),
      toolResult("t4", "OUTPUT_MARKER_4", true),
    ];
    const sent = JSON.stringify(lines.flatMap((line) => map(line)));
    expect(sent).not.toMatch(/OUTPUT_MARKER|INPUT_MARKER|DESCRIPTION_MARKER/);
  });

  it("scrubs placeholders out of commands, thoughts and plans", () => {
    const map = mapper(panelScrub({ redact: identity, guardValues: () => [] }));
    const events = [
      toolUse("t1", "Bash", { command: "psql STEWARD_PH_DB_0123456789abcdef -c 'select 1'" }),
      assistant([{ type: "text", text: "Using STEWARD_PH_API_KEY_fedcba9876543210 for the call." }]),
      toolUse("t2", "TodoWrite", { todos: [{ content: "Set STEWARD_PH_DB_0123456789abcdef", status: "pending", activeForm: "Setting" }] }),
    ].flatMap((line) => map(line));
    const sent = JSON.stringify(events);
    expect(sent).not.toContain("STEWARD_PH_");
    expect(sent).not.toContain("0123456789abcdef");
    expect(events[0]).toEqual({ activity: { type: "action", action: "Running", parameter: "psql [placeholder] -c 'select 1'" }, ephemeral: true });
  });

  it("maps TodoWrite to a plan with Linear's statuses and no action", () => {
    const map = mapper();
    const events = map(
      toolUse("t1", "TodoWrite", {
        todos: [
          { content: "Read the ticket", status: "completed", activeForm: "Reading the ticket" },
          { content: "Write the fix", status: "in_progress", activeForm: "Writing the fix" },
          { content: "Run the checks", status: "pending", activeForm: "Running the checks" },
        ],
      }),
    );
    expect(events).toEqual<PanelEvent[]>([
      {
        plan: [
          { content: "Read the ticket", status: "completed" },
          { content: "Write the fix", status: "inProgress" },
          { content: "Run the checks", status: "pending" },
        ],
      },
    ]);
    expect(map(toolResult("t1", "Todos have been modified successfully"))).toEqual([]);
  });

  it("ignores lines that are not assistant or user messages, and lines that are not JSON", () => {
    const map = mapper();
    expect(map(JSON.stringify({ type: "system", subtype: "init", session_id: "s-1" }))).toEqual([]);
    expect(map(JSON.stringify({ type: "result", subtype: "success", result: "done" }))).toEqual([]);
    expect(map(JSON.stringify({ type: "fake", prompt: "x" }))).toEqual([]);
    expect(map("not json")).toEqual([]);
    expect(map(JSON.stringify({ type: "user", message: { role: "user", content: "a steered message" } }))).toEqual([]);
  });
});

describe("panelScrub", () => {
  it("applies the run redactor, replaces placeholders and masks guard values", () => {
    const scrub = panelScrub({
      redact: (text) => text.replace("glpat-abcdefgh123", "***"),
      guardValues: () => ["real-database-password", "STEWARD_PH_DB_0123456789abcdef", "short"],
    });
    expect(scrub("token glpat-abcdefgh123, db real-database-password, ph STEWARD_PH_DB_0123456789abcdef, word short")).toBe(
      "token ***, db ***, ph [placeholder], word ***",
    );
  });
});
