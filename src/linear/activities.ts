import { isAbsolute, relative } from "node:path";
import { z } from "zod";
import type { ActivityContent, PlanStep } from "../tracker/linear/agent.js";

/** One thing for the agent panel: an activity, or the session's whole plan. */
export type PanelEvent = { activity: ActivityContent; ephemeral: boolean } | { plan: PlanStep[] };

const MAX_COMMAND_CHARS = 80;
const PLACEHOLDER = /STEWARD_PH_[A-Za-z0-9_]+/g;
const MASK = "***";
/** Shorter guard values are left alone: masking them would mangle ordinary words. */
const MIN_GUARD_LENGTH = 4;

const escapeRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * What runs over every text the panel shows: placeholders become "[placeholder]", guard values (every real value and
 * placeholder of the run's overlay, from 4 chars) are masked, then the run redactor applies.
 */
export const panelScrub =
  (p: { redact: (text: string) => string; guardValues: () => string[] }) =>
  (text: string): string => {
    const guards = [...new Set(p.guardValues().filter((value) => value.length >= MIN_GUARD_LENGTH))].sort((a, b) => b.length - a.length);
    const withoutPlaceholders = text.replace(PLACEHOLDER, "[placeholder]");
    const withoutGuards = guards.length === 0 ? withoutPlaceholders : withoutPlaceholders.replace(new RegExp(guards.map(escapeRegExp).join("|"), "g"), MASK);
    return p.redact(withoutGuards);
  };

const TextBlock = z.object({ type: z.literal("text"), text: z.string() });
const ToolUseBlock = z.object({ type: z.literal("tool_use"), id: z.string(), name: z.string(), input: z.unknown() });
const ToolResultBlock = z.object({ type: z.literal("tool_result"), tool_use_id: z.string(), is_error: z.boolean().optional() });
const AssistantLine = z.object({ type: z.literal("assistant"), message: z.object({ content: z.array(z.unknown()) }) });
const UserLine = z.object({ type: z.literal("user"), message: z.object({ content: z.union([z.string(), z.array(z.unknown())]) }) });
const FileInput = z.object({ file_path: z.string() });
const CommandInput = z.object({ command: z.string() });
const TodoInput = z.object({
  todos: z.array(z.object({ content: z.string(), status: z.enum(["pending", "in_progress", "completed"]) })),
});

const PLAN_STATUS: Record<z.infer<typeof TodoInput>["todos"][number]["status"], PlanStep["status"]> = {
  pending: "pending",
  in_progress: "inProgress",
  completed: "completed",
};

/** A started tool call whose result the panel reports. */
interface Pending {
  action: string;
  parameter: string;
}

/** The action and parameter shown for a tool call, and whether its result is shown; null for TodoWrite (a plan). */
const describeTool = (name: string, input: unknown, workspacePath: string | undefined): (Pending & { reportsResult: boolean }) | null => {
  if (name === "TodoWrite") return null;
  if (name === "Edit" || name === "Write" || name === "MultiEdit") {
    const parsed = FileInput.safeParse(input);
    const path = parsed.success ? parsed.data.file_path : "";
    const shown = workspacePath !== undefined && isAbsolute(path) && path.startsWith(`${workspacePath}/`) ? relative(workspacePath, path) : path;
    return { action: "Editing", parameter: shown, reportsResult: true };
  }
  if (name === "Bash") {
    const parsed = CommandInput.safeParse(input);
    const firstLine = parsed.success ? (parsed.data.command.split("\n")[0] ?? "").trim() : "";
    return { action: "Running", parameter: firstLine.slice(0, MAX_COMMAND_CHARS), reportsResult: true };
  }
  if (name === "Read") return { action: "Reading", parameter: "", reportsResult: false };
  if (name === "Grep" || name === "Glob") return { action: "Searching", parameter: "", reportsResult: false };
  if (name.startsWith("mcp__push__")) return { action: "Pushing", parameter: "", reportsResult: true };
  if (name.startsWith("mcp__playwright__")) return { action: "Browsing", parameter: "", reportsResult: false };
  return { action: name, parameter: "", reportsResult: false };
};

const parseJson = (line: string): unknown => {
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
};

/**
 * Maps one run's brain lines (one SDK message as JSON per line) to panel events. Stateful: a tool result is shown with
 * the action of the call it answers, so one mapper serves one run. Assistant text becomes a thought (adjacent text
 * blocks joined), a tool call an ephemeral action, an edit, write, command or push result a lasting action with "ok" or
 * "failed", and TodoWrite the plan. No tool output, and no tool input beyond the action's parameter, is ever shown;
 * every text passes `scrub`.
 */
export const createBrainLineMapper = (p: { scrub: (text: string) => string; workspacePath?: string }): ((line: string) => PanelEvent[]) => {
  const pending = new Map<string, Pending>();

  const fromAssistant = (content: unknown[]): PanelEvent[] => {
    const events: PanelEvent[] = [];
    let texts: string[] = [];
    const endThought = (): void => {
      const body = texts.join("\n\n").trim();
      texts = [];
      if (body !== "") events.push({ activity: { type: "thought", body: p.scrub(body) }, ephemeral: false });
    };
    for (const block of content) {
      const text = TextBlock.safeParse(block);
      if (text.success) {
        if (text.data.text.trim() !== "") texts.push(text.data.text.trim());
        continue;
      }
      const tool = ToolUseBlock.safeParse(block);
      if (!tool.success) continue;
      endThought();
      const described = describeTool(tool.data.name, tool.data.input, p.workspacePath);
      if (described === null) {
        const todos = TodoInput.safeParse(tool.data.input);
        if (todos.success) events.push({ plan: todos.data.todos.map((todo) => ({ content: p.scrub(todo.content), status: PLAN_STATUS[todo.status] })) });
        continue;
      }
      const shown = { action: described.action, parameter: p.scrub(described.parameter) };
      if (described.reportsResult) pending.set(tool.data.id, shown);
      events.push({ activity: { type: "action", ...shown }, ephemeral: true });
    }
    endThought();
    return events;
  };

  const fromUser = (content: unknown[]): PanelEvent[] =>
    content.flatMap((block): PanelEvent[] => {
      const result = ToolResultBlock.safeParse(block);
      if (!result.success) return [];
      const call = pending.get(result.data.tool_use_id);
      if (call === undefined) return [];
      pending.delete(result.data.tool_use_id);
      return [{ activity: { type: "action", ...call, result: result.data.is_error === true ? "failed" : "ok" }, ephemeral: false }];
    });

  return (line) => {
    const message = parseJson(line);
    const assistant = AssistantLine.safeParse(message);
    if (assistant.success) return fromAssistant(assistant.data.message.content);
    const user = UserLine.safeParse(message);
    if (user.success && Array.isArray(user.data.message.content)) return fromUser(user.data.message.content);
    return [];
  };
};
