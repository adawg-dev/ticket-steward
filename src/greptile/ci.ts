import type { FailedJob, GitLabMrApi } from "../codehost/gitlabMr.js";
import type { Redactor } from "../core/redact.js";

export interface CiFailure { name: string; stage: string; webUrl: string; logTail: string }

/** A pipeline's failed jobs (`GitLabMrApi.failedJobs`, downstream pipelines included) with the redacted tail of each trace. */
export const ciFailuresOf = async (
  gitlab: GitLabMrApi, project: number, jobs: FailedJob[], lines: number, redactor: Redactor,
): Promise<CiFailure[]> => {
  const out: CiFailure[] = [];
  for (const job of jobs) {
    const tail = await gitlab.jobTraceTail(project, job.id, lines);
    out.push({ name: job.name, stage: job.stage, webUrl: job.webUrl, logTail: redactor.redact(tail) });
  }
  return out;
};
