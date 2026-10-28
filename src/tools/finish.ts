import { errorMessage } from "../core/workspace.js";
import { unpushedWork } from "../implement/git.js";
import type { PushLedger } from "../push/ledger.js";
import type { PushGuard } from "../push/service.js";
import { WorkReportSchema, type RunSpec, type WorkReport } from "../run/protocol.js";

const REQUEST_TIMEOUT_MS = 60_000;

/** The ledger, remembering the last push that landed in this run: the sidecar's pushes are the run's only ones. */
export const recordingLedger = (ledger: PushLedger): { ledger: PushLedger; lastPushed: () => string | null } => {
  let last: string | null = null;
  return {
    ledger: {
      ...ledger,
      landed: async (target, id, sha) => {
        await ledger.landed(target, id, sha);
        last = sha;
      },
    },
    lastPushed: () => last,
  };
};

/**
 * What the agent left after the run's last push, or after the commit the run started at (a pod's worktree is cloned fresh
 * at `checkout.sha`), read from git alone with the worktree's config neutralised. A worktree that cannot be read counts
 * as unpushed work, so the run hands back instead of passing over it.
 */
export const toolsWork = async (p: { spec: RunSpec; pushedSha: string | null; guard: () => Promise<PushGuard> }): Promise<WorkReport> => {
  try {
    const { stewardFiles } = await p.guard();
    const work = await unpushedWork({ worktreePath: p.spec.worktreePath, pushedSha: p.pushedSha ?? p.spec.checkout.sha, stewardFiles });
    return { runId: p.spec.runId, unpushed: work.summary, pushedSha: p.pushedSha };
  } catch (err) {
    return { runId: p.spec.runId, unpushed: `the worktree could not be read: ${errorMessage(err)}`, pushedSha: p.pushedSha };
  }
};

/** Delivers the work report to the dispatcher (`POST …/internal/runs/<runId>/work`) with the run's tools token. */
export const postWork = async (p: { baseUrl: string; token: string; work: WorkReport }): Promise<void> => {
  const url = `${p.baseUrl.replace(/\/+$/, "")}/internal/runs/${encodeURIComponent(p.work.runId)}/work`;
  const response = await fetch(url, {
    method: "POST",
    headers: { authorization: `Bearer ${p.token}`, "content-type": "application/json" },
    body: JSON.stringify(WorkReportSchema.parse(p.work)),
    redirect: "error",
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (response.status === 401) throw new Error("the run's tools token was rejected");
  if (!response.ok) throw new Error(`the steward answered ${response.status} to the work report`);
};
