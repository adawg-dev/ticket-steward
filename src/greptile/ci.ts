import type { GitLabMrApi } from "../codehost/gitlabMr.js";
import type { Redactor } from "../core/redact.js";

export interface CiFailure { name: string; stage: string; webUrl: string; logTail: string }

/** Failed jobs of a pipeline (downstream pipelines included) with the redacted tail of each trace. */
export const collectCiFailures = async (
  gitlab: GitLabMrApi, project: number, pipelineId: number, lines: number, redactor: Redactor,
): Promise<CiFailure[]> => {
  const jobs = await gitlab.failedJobs(project, pipelineId);
  const out: CiFailure[] = [];
  for (const job of jobs) {
    const tail = await gitlab.jobTraceTail(project, job.id, lines);
    out.push({ name: job.name, stage: job.stage, webUrl: job.webUrl, logTail: redactor.redact(tail) });
  }
  return out;
};
