import { z } from "zod";
import type { Secrets } from "../config/load.js";
import type { StewardConfig } from "../config/schema.js";

/** A numeric project id or a "group/project" path (URL-encoded by the client). */
export type ProjectRef = number | string;
export interface PipelineRef { id: number; sha: string; status: string }
export interface MergeRequestInfo {
  projectId: number; iid: number; state: string; sha: string; title: string; description: string;
  webUrl: string; sourceBranch: string; targetBranch: string; updatedAt: string; headPipeline: PipelineRef | null;
}
export interface NotePosition { newPath: string | null; oldPath: string | null; newLine: number | null; oldLine: number | null }
export interface MrNote {
  id: number; body: string; author: string; system: boolean; resolvable: boolean; resolved: boolean;
  type: string | null; createdAt: string; updatedAt: string; position: NotePosition | null;
}
export interface MrDiscussion { id: string; notes: MrNote[] }
export interface FailedJob { id: number; name: string; stage: string; webUrl: string }
export interface GitLabMrApi {
  currentUser(): Promise<{ username: string }>;
  tokenScopes(): Promise<string[]>;
  userExists(username: string): Promise<boolean>;
  getMergeRequest(project: ProjectRef, iid: number): Promise<MergeRequestInfo>;
  findOpenMergeRequest(project: ProjectRef, sourceBranch: string): Promise<MergeRequestInfo | null>;
  listDiscussions(project: ProjectRef, iid: number): Promise<MrDiscussion[]>;
  createNote(project: ProjectRef, iid: number, body: string): Promise<void>;
  replyToDiscussion(project: ProjectRef, iid: number, discussionId: string, body: string): Promise<void>;
  resolveDiscussion(project: ProjectRef, iid: number, discussionId: string): Promise<void>;
  /** Failed jobs of the pipeline and of every downstream pipeline reached through its bridges (depth <= 3). */
  failedJobs(project: ProjectRef, pipelineId: number): Promise<FailedJob[]>;
  /** The last `lines` lines of the job's trace. */
  jobTraceTail(project: ProjectRef, jobId: number, lines: number): Promise<string>;
}

export class GitLabApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "GitLabApiError";
  }
}

const MergeRequestSchema = z.object({
  project_id: z.number(),
  iid: z.number(),
  state: z.string(),
  sha: z.string(),
  title: z.string(),
  description: z.string().nullish(),
  web_url: z.string(),
  source_branch: z.string(),
  target_branch: z.string(),
  updated_at: z.string(),
  head_pipeline: z.object({ id: z.number(), sha: z.string(), status: z.string() }).nullish(),
});
const NoteSchema = z.object({
  id: z.number(),
  body: z.string(),
  author: z.object({ username: z.string() }),
  system: z.boolean(),
  resolvable: z.boolean().nullish(),
  resolved: z.boolean().nullish(),
  type: z.string().nullish(),
  created_at: z.string(),
  updated_at: z.string(),
  position: z
    .object({ new_path: z.string().nullish(), old_path: z.string().nullish(), new_line: z.number().nullish(), old_line: z.number().nullish() })
    .nullish(),
});
const DiscussionSchema = z.object({ id: z.string(), notes: z.array(NoteSchema) });
const JobSchema = z.object({ id: z.number(), name: z.string(), stage: z.string(), web_url: z.string() });
const BridgeSchema = z.object({ downstream_pipeline: z.object({ id: z.number() }).nullish() });
const UserSchema = z.object({ username: z.string() });
const TokenSchema = z.object({ scopes: z.array(z.string()) });

export interface GitLabMrClientOptions {
  baseUrl: string;
  token: string;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
}

const MAX_RETRIES = 3;
const MAX_WAIT_MS = 60_000;
const PER_PAGE = 100;
const MAX_PAGES = 50;

const MAX_DOWNSTREAM_DEPTH = 3;

const toMergeRequest = (mr: z.infer<typeof MergeRequestSchema>): MergeRequestInfo => ({
  projectId: mr.project_id,
  iid: mr.iid,
  state: mr.state,
  sha: mr.sha,
  title: mr.title,
  description: mr.description ?? "",
  webUrl: mr.web_url,
  sourceBranch: mr.source_branch,
  targetBranch: mr.target_branch,
  updatedAt: mr.updated_at,
  headPipeline: mr.head_pipeline ?? null,
});

export class GitLabMrClient implements GitLabMrApi {
  private readonly api: string;
  private readonly token: string;
  private readonly fetchImpl: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(opts: GitLabMrClientOptions) {
    this.api = `${opts.baseUrl.replace(/\/+$/, "")}/api/v4`;
    this.token = opts.token;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.sleep = opts.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  async currentUser(): Promise<{ username: string }> {
    return UserSchema.parse(await (await this.request("GET", "/user")).json());
  }

  async tokenScopes(): Promise<string[]> {
    return TokenSchema.parse(await (await this.request("GET", "/personal_access_tokens/self")).json()).scopes;
  }

  async userExists(username: string): Promise<boolean> {
    const users = z.array(UserSchema).parse(await (await this.request("GET", `/users?username=${encodeURIComponent(username)}`)).json());
    return users.length > 0;
  }

  async getMergeRequest(project: ProjectRef, iid: number): Promise<MergeRequestInfo> {
    return toMergeRequest(MergeRequestSchema.parse(await (await this.request("GET", this.mrPath(project, iid))).json()));
  }

  async findOpenMergeRequest(project: ProjectRef, sourceBranch: string): Promise<MergeRequestInfo | null> {
    const path = `${this.projectPath(project)}/merge_requests?state=opened&source_branch=${encodeURIComponent(sourceBranch)}`;
    const [first] = z.array(MergeRequestSchema).parse(await (await this.request("GET", path)).json());
    return first === undefined ? null : toMergeRequest(first);
  }

  async listDiscussions(project: ProjectRef, iid: number): Promise<MrDiscussion[]> {
    const items = await this.paged(`${this.mrPath(project, iid)}/discussions`, DiscussionSchema);
    return items.map((item) => ({
      id: item.id,
      notes: item.notes.map((note) => ({
        id: note.id,
        body: note.body,
        author: note.author.username,
        system: note.system,
        resolvable: note.resolvable ?? false,
        resolved: note.resolved ?? false,
        type: note.type ?? null,
        createdAt: note.created_at,
        updatedAt: note.updated_at,
        position:
          note.position === null || note.position === undefined
            ? null
            : {
                newPath: note.position.new_path ?? null,
                oldPath: note.position.old_path ?? null,
                newLine: note.position.new_line ?? null,
                oldLine: note.position.old_line ?? null,
              },
      })),
    }));
  }

  async createNote(project: ProjectRef, iid: number, body: string): Promise<void> {
    await this.request("POST", `${this.mrPath(project, iid)}/notes`, { body });
  }

  async replyToDiscussion(project: ProjectRef, iid: number, discussionId: string, body: string): Promise<void> {
    await this.request("POST", `${this.mrPath(project, iid)}/discussions/${discussionId}/notes`, { body });
  }

  async resolveDiscussion(project: ProjectRef, iid: number, discussionId: string): Promise<void> {
    await this.request("PUT", `${this.mrPath(project, iid)}/discussions/${discussionId}?resolved=true`);
  }

  async failedJobs(project: ProjectRef, pipelineId: number): Promise<FailedJob[]> {
    return this.failedJobsAt(project, pipelineId, 0);
  }

  async jobTraceTail(project: ProjectRef, jobId: number, lines: number): Promise<string> {
    const trace = await (await this.request("GET", `${this.projectPath(project)}/jobs/${jobId}/trace`)).text();
    return trace.replace(/\n+$/, "").split("\n").slice(-lines).join("\n");
  }

  private async failedJobsAt(project: ProjectRef, pipelineId: number, depth: number): Promise<FailedJob[]> {
    const base = `${this.projectPath(project)}/pipelines/${pipelineId}`;
    const jobs = (await this.paged(`${base}/jobs?scope[]=failed`, JobSchema)).map((job) => ({ id: job.id, name: job.name, stage: job.stage, webUrl: job.web_url }));
    if (depth >= MAX_DOWNSTREAM_DEPTH) return jobs;
    const bridges = await this.paged(`${base}/bridges`, BridgeSchema);
    for (const bridge of bridges) {
      if (bridge.downstream_pipeline === null || bridge.downstream_pipeline === undefined) continue;
      jobs.push(...(await this.failedJobsAt(project, bridge.downstream_pipeline.id, depth + 1)));
    }
    return jobs;
  }

  private projectPath(project: ProjectRef): string {
    return `/projects/${typeof project === "number" ? project : encodeURIComponent(project)}`;
  }

  private mrPath(project: ProjectRef, iid: number): string {
    return `${this.projectPath(project)}/merge_requests/${iid}`;
  }

  /** Follows `x-next-page` until it runs out; `path` may already carry a query string. */
  private async paged<T>(path: string, schema: z.ZodType<T>): Promise<T[]> {
    const all: T[] = [];
    const sep = path.includes("?") ? "&" : "?";
    for (let page = 1; page <= MAX_PAGES; page += 1) {
      const response = await this.request("GET", `${path}${sep}per_page=${PER_PAGE}&page=${page}`);
      const items = z.array(schema).parse(await response.json());
      all.push(...items);
      const next = response.headers.get("x-next-page");
      if (next === null || next === "" || items.length === 0) break;
    }
    return all;
  }

  /** GitLab.com limits note creation to about 60 per minute per user; a 429 waits out Retry-After. */
  private async request(method: string, path: string, body?: unknown): Promise<Response> {
    for (let attempt = 0; ; attempt += 1) {
      const response = await this.fetchImpl(`${this.api}${path}`, {
        method,
        headers: { "PRIVATE-TOKEN": this.token, ...(body === undefined ? {} : { "content-type": "application/json" }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      if (response.status === 429 && attempt < MAX_RETRIES) {
        const seconds = Number(response.headers.get("retry-after") ?? "1");
        await this.sleep(Math.min(MAX_WAIT_MS, (Number.isFinite(seconds) && seconds > 0 ? seconds : 1) * 1000));
        continue;
      }
      if (!response.ok) throw new GitLabApiError(response.status, `GitLab ${method} ${path.split("?")[0] ?? path} answered ${response.status}: ${(await response.text()).slice(0, 300)}`);
      return response;
    }
  }
}

/** The loop's GitLab client; until the `greptile` config gate exists it needs a GitLab code host and `GITLAB_TOKEN`. */
export const createGitLabMr = (config: StewardConfig, secrets: Secrets): GitLabMrApi | undefined => {
  const token = secrets.GITLAB_TOKEN;
  if (config.codehost.kind !== "gitlab" || token === undefined || token === "") return undefined;
  return new GitLabMrClient({ baseUrl: config.codehost.baseUrl, token });
};
