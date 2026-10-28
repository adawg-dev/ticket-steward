import { request } from "node:http";
import { z } from "zod";
import { buildWorkspaceEnv } from "../brain/env.js";
import { errorMessage } from "../core/workspace.js";
import { runSetup } from "../workspace/setup.js";

/**
 * Runs the steward's checks for a push. The checks guard quality, not a hostile agent: on the local runtime they run here,
 * in the worktree; in a run pod the tools sidecar asks the agent container, which holds the toolchain and no credential.
 */
export interface CheckRunner {
  run(commands: string[]): Promise<{ ok: boolean; tail: string }>;
}

/** Runs the checks in-process in the worktree, with the run's workspace env on its app port. */
export const localCheckRunner = (p: { worktreePath: string; port: number; timeoutMs: number; tailBytes: number }): CheckRunner => ({
  run: (commands) => runSetup(commands, p.worktreePath, buildWorkspaceEnv(p.port), { timeoutMs: p.timeoutMs, tailBytes: p.tailBytes }),
});

const CheckAnswer = z.object({ ok: z.boolean(), tail: z.string() });

/**
 * Asks the agent container's check endpoint (`POST <baseUrl>/checks`) to run the checks. `node:http` rather than fetch,
 * whose default header timeout (300 s) is shorter than a check run. An endpoint that cannot answer fails the checks.
 */
export const httpCheckRunner = (baseUrl: string, timeoutMs: number): CheckRunner => ({
  run: (commands) => {
    if (commands.length === 0) return Promise.resolve({ ok: true, tail: "" });
    const body = JSON.stringify({ commands });
    return new Promise((resolve) => {
      const failed = (why: string): void => resolve({ ok: false, tail: `the agent's check endpoint ${why}` });
      const req = request(new URL("/checks", baseUrl), { method: "POST", headers: { "content-type": "application/json", "content-length": Buffer.byteLength(body) }, timeout: timeoutMs }, (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("error", (err) => failed(`failed: ${errorMessage(err)}`));
        res.on("end", () => {
          if (res.statusCode !== 200) return failed(`answered ${res.statusCode ?? "without a status"}`);
          try {
            resolve(CheckAnswer.parse(JSON.parse(Buffer.concat(chunks).toString("utf8"))));
          } catch {
            failed("answered something other than { ok, tail }");
          }
        });
      });
      req.on("timeout", () => req.destroy(new Error(`timed out after ${Math.round(timeoutMs / 1000)} s`)));
      req.on("error", (err) => failed(`failed: ${errorMessage(err)}`));
      req.end(body);
    });
  },
});
