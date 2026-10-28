import { homedir } from "node:os";
import { z } from "zod";
import type { StdioMcpServerSpec } from "../brain/types.js";

/**
 * What one run may push, fixed by the steward when it spawns the push server. Carries no secrets: it travels on the
 * `claude` command line. `branch` is null for implement's first push (the agent names the branch type then); `baseSha`
 * is the job's or loop's original base, used for `{{baseSha}}` in the checks and as the base a create pushes onto.
 * `port` is the run's app port, so the steward's checks see the same env as the run's setup.
 */
export const PushTargetSchema = z.object({
  jobId: z.number().int().positive(),
  worktreePath: z.string().min(1),
  identifier: z.string().min(1),
  issueId: z.string().min(1),
  mode: z.enum(["create", "fastForward"]),
  branch: z.string().min(1).nullable(),
  baseSha: z.string().regex(/^[0-9a-f]{40}$/),
  loopId: z.number().int().positive().nullable(),
  port: z.number().int().positive(),
});

export type PushTarget = z.infer<typeof PushTargetSchema>;

/**
 * Spawn spec for `steward mcp push`. Like `codehostMcpSpec`, the env carries no secrets: the server loads the push token
 * itself from the config's `.env`, so it never reaches the brain's process or command line.
 */
export const pushMcpSpec = (p: { binPath: string; configPath: string; target: PushTarget }): StdioMcpServerSpec => ({
  command: process.execPath,
  args: [p.binPath, "mcp", "push", "--config", p.configPath, "--target", JSON.stringify(p.target)],
  env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? homedir() },
});
