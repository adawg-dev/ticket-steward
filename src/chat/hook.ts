import { z } from "zod";
import { evaluateTool, POLICY_HOOK_MATCHER, type PolicyDecision } from "../brain/policy.js";

/** The part of Claude Code's hook input (JSON on stdin) the policy reads. */
const HookInputSchema = z.object({
  hook_event_name: z.string(),
  tool_name: z.string().optional(),
  tool_input: z.unknown().optional(),
});

/** MCP tools go through the hook too, so only the steward's servers' tools run. */
const CHAT_HOOK_MATCHER = `${POLICY_HOOK_MATCHER}|mcp__.*`;

/** Claude Code's command-hook contract: exit 2 blocks the tool call and shows stderr to the model. */
export const HOOK_DENY_EXIT = 2;

const quote = (arg: string): string => `'${arg.replaceAll("'", `'\\''`)}'`;

/**
 * The verdict on one hook call, by the same rules as the brain's in-process hook. Events other than PreToolUse allow;
 * input that is not a hook payload denies, so a broken call never runs a tool unchecked.
 */
export const evaluateHook = (raw: string, scope: { workspacePath: string; artifactsDir: string; denyPaths: string[] }): PolicyDecision => {
  let parsed: z.infer<typeof HookInputSchema>;
  try {
    parsed = HookInputSchema.parse(JSON.parse(raw));
  } catch {
    return { allow: false, reason: "the policy hook could not read its input" };
  }
  if (parsed.hook_event_name !== "PreToolUse") return { allow: true };
  if (parsed.tool_name === undefined) return { allow: false, reason: "the policy hook got no tool name" };
  return evaluateTool({ name: parsed.tool_name, input: parsed.tool_input, ...scope });
};

/**
 * `--settings` for the interactive CLI: the brain's tool rules as a PreToolUse command hook (`steward chat-hook`), and the
 * brain's transcript retention. The command carries paths only, never a secret. `denyPaths` names the denied paths on the
 * command itself (a run pod, whose agent container cannot load the config's secrets); without it the hook derives them
 * from the config. The CLI also loads the worktree's project settings, which the agent can write; flag settings win only
 * for the keys they set, so these pin the ones that would turn the hook off (`disableAllHooks`) or skip the owner's
 * prompts (bypass mode). A project allow rule still only skips the prompt: the hook runs, and blocks, either way.
 */
export const chatSettings = (p: {
  nodePath: string;
  binPath: string;
  configPath: string;
  workspacePath: string;
  artifactsDir: string;
  cleanupPeriodDays: number;
  denyPaths?: string[];
}): Record<string, unknown> => {
  const deny = (p.denyPaths ?? []).flatMap((path) => ["--deny", path]);
  const command = [p.nodePath, p.binPath, "--config", p.configPath, "chat-hook", "--workspace", p.workspacePath, "--artifacts", p.artifactsDir, ...deny].map(quote).join(" ");
  return {
    cleanupPeriodDays: p.cleanupPeriodDays,
    disableAllHooks: false,
    permissions: { defaultMode: "default", disableBypassPermissionsMode: "disable" },
    hooks: { PreToolUse: [{ matcher: CHAT_HOOK_MATCHER, hooks: [{ type: "command", command }] }] },
  };
};
