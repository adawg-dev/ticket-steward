import { z } from "zod";
import type { Secrets } from "../config/load.js";
import type { StewardConfig } from "../config/schema.js";

export interface DiffRefs { baseSha: string; startSha: string; headSha: string }
export interface MergeRequestInfo {
  projectId: number; iid: number; state: string; sha: string; title: string; description: string;
  webUrl: string; sourceBranch: string; targetBranch: string; reviewers: string[]; diffRefs: DiffRefs | null;
}
export interface ReviewNote { id: number; body: string; author: string; system: boolean; resolvable: boolean; resolved: boolean }
export interface ReviewDiscussion { id: string; notes: ReviewNote[] }
export interface DiffPosition { baseSha: string; startSha: string; headSha: string; oldPath: string; newPath: string; oldLine: number | null; newLine: number | null }
export interface GitLabReviewApi {
  currentUser(): Promise<{ username: string }>;
  tokenScopes(): Promise<string[]>;
  getMergeRequest(projectId: number, iid: number): Promise<MergeRequestInfo>;
  listDiscussions(projectId: number, iid: number): Promise<ReviewDiscussion[]>;
  createDiffDiscussion(projectId: number, iid: number, body: string, position: DiffPosition): Promise<void>;
  createNote(projectId: number, iid: number, body: string): Promise<void>;
  replyToDiscussion(projectId: number, iid: number, discussionId: string, body: string): Promise<void>;
  resolveDiscussion(projectId: number, iid: number, discussionId: string): Promise<void>;
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
  reviewers: z.array(z.object({ username: z.string() })).nullish(),
  diff_refs: z.object({ base_sha: z.string().nullable(), start_sha: z.string().nullable(), head_sha: z.string().nullable() }).nullish(),
});
const NoteSchema = z.object({
  id: z.number(),
  body: z.string(),
  author: z.object({ username: z.string() }),
  system: z.boolean(),
  resolvable: z.boolean().nullish(),
  resolved: z.boolean().nullish(),
});
const DiscussionsSchema = z.array(z.object({ id: z.string(), notes: z.array(NoteSchema) }));
const UserSchema = z.object({ username: z.string() });
const TokenSchema = z.object({ scopes: z.array(z.string()) });

export interface GitLabReviewClientOptions {
  baseUrl: string;
  token: string;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
}

const MAX_RETRIES = 3;
const MAX_WAIT_MS = 60_000;
const PER_PAGE = 100;
const MAX_PAGES = 50;

const toDiffRefs = (refs: z.infer<typeof MergeRequestSchema>["diff_refs"]): DiffRefs | null =>
  refs === null || refs === undefined || refs.base_sha === null || refs.start_sha === null || refs.head_sha === null
    ? null
    : { baseSha: refs.base_sha, startSha: refs.start_sha, headSha: refs.head_sha };

export class GitLabReviewClient implements GitLabReviewApi {
  private readonly api: string;
  private readonly token: string;
  private readonly fetchImpl: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(opts: GitLabReviewClientOptions) {
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

  async getMergeRequest(projectId: number, iid: number): Promise<MergeRequestInfo> {
    const mr = MergeRequestSchema.parse(await (await this.request("GET", this.mrPath(projectId, iid))).json());
    return {
      projectId: mr.project_id,
      iid: mr.iid,
      state: mr.state,
      sha: mr.sha,
      title: mr.title,
      description: mr.description ?? "",
      webUrl: mr.web_url,
      sourceBranch: mr.source_branch,
      targetBranch: mr.target_branch,
      reviewers: (mr.reviewers ?? []).map((reviewer) => reviewer.username),
      diffRefs: toDiffRefs(mr.diff_refs),
    };
  }

  async listDiscussions(projectId: number, iid: number): Promise<ReviewDiscussion[]> {
    const all: ReviewDiscussion[] = [];
    for (let page = 1; page <= MAX_PAGES; page += 1) {
      const response = await this.request("GET", `${this.mrPath(projectId, iid)}/discussions?per_page=${PER_PAGE}&page=${page}`);
      const items = DiscussionsSchema.parse(await response.json());
      all.push(
        ...items.map((item) => ({
          id: item.id,
          notes: item.notes.map((note) => ({
            id: note.id,
            body: note.body,
            author: note.author.username,
            system: note.system,
            resolvable: note.resolvable ?? false,
            resolved: note.resolved ?? false,
          })),
        })),
      );
      const next = response.headers.get("x-next-page");
      if (next === null || next === "" || items.length === 0) break;
    }
    return all;
  }

  async createDiffDiscussion(projectId: number, iid: number, body: string, position: DiffPosition): Promise<void> {
    await this.request("POST", `${this.mrPath(projectId, iid)}/discussions`, {
      body,
      position: {
        position_type: "text",
        base_sha: position.baseSha,
        start_sha: position.startSha,
        head_sha: position.headSha,
        old_path: position.oldPath,
        new_path: position.newPath,
        ...(position.oldLine === null ? {} : { old_line: position.oldLine }),
        ...(position.newLine === null ? {} : { new_line: position.newLine }),
      },
    });
  }

  async createNote(projectId: number, iid: number, body: string): Promise<void> {
    await this.request("POST", `${this.mrPath(projectId, iid)}/notes`, { body });
  }

  async replyToDiscussion(projectId: number, iid: number, discussionId: string, body: string): Promise<void> {
    await this.request("POST", `${this.mrPath(projectId, iid)}/discussions/${discussionId}/notes`, { body });
  }

  async resolveDiscussion(projectId: number, iid: number, discussionId: string): Promise<void> {
    await this.request("PUT", `${this.mrPath(projectId, iid)}/discussions/${discussionId}?resolved=true`);
  }

  private mrPath(projectId: number, iid: number): string {
    return `/projects/${projectId}/merge_requests/${iid}`;
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

export const createGitLabReview = (config: StewardConfig, secrets: Secrets): GitLabReviewApi | undefined => {
  const token = secrets.GITLAB_TOKEN;
  if (config.codehost.kind !== "gitlab" || token === undefined || token === "") return undefined;
  return new GitLabReviewClient({ baseUrl: config.codehost.baseUrl, token });
};
