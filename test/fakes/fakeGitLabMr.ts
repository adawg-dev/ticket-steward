import type { FailedJob, GitLabMrApi, MergeRequestInfo, MrDiscussion } from "../../src/codehost/gitlabMr.js";

export const BOT = "steward-bot";

export const fakeMergeRequest = (overrides: Partial<MergeRequestInfo> = {}): MergeRequestInfo => ({
  projectId: 42,
  iid: 7,
  state: "opened",
  sha: "c".repeat(40),
  title: "Fix final chunk",
  description: "",
  webUrl: "https://gitlab.example/acme/repo/-/merge_requests/7",
  sourceBranch: "api-1-fix",
  targetBranch: "main",
  updatedAt: "2026-10-27T10:00:00Z",
  headPipeline: null,
  ...overrides,
});

/** In-memory GitLab: created notes appear in listDiscussions, like the real API. */
export class FakeGitLabMr implements GitLabMrApi {
  mr: MergeRequestInfo;
  /** What findOpenMergeRequest answers. */
  openMr: MergeRequestInfo | null = null;
  discussions: MrDiscussion[] = [];
  /** Failed jobs failedJobs answers, whatever the pipeline. */
  failed: FailedJob[] = [];
  /** Job traces by job id; jobTraceTail returns the last lines of one. */
  traces = new Map<number, string>();
  /** Usernames userExists answers true for. */
  users = new Set<string>();
  scopes = ["api"];
  readonly notes: string[] = [];
  readonly replies: Array<{ discussionId: string; body: string }> = [];
  readonly resolved: string[] = [];
  private nextId = 1;

  constructor(mr: MergeRequestInfo = fakeMergeRequest()) {
    this.mr = mr;
  }

  addDiscussion(author: string, body: string, opts: { resolvable?: boolean; resolved?: boolean } = {}): string {
    const id = `d${this.nextId++}`;
    this.discussions.push({
      id,
      notes: [{
        id: this.nextId++, body, author, system: false, resolvable: opts.resolvable ?? true, resolved: opts.resolved ?? false,
        type: null, createdAt: "2026-10-27T10:00:00Z", updatedAt: "2026-10-27T10:00:00Z", position: null,
      }],
    });
    return id;
  }

  async currentUser(): Promise<{ username: string }> {
    return { username: BOT };
  }

  async tokenScopes(): Promise<string[]> {
    return [...this.scopes];
  }

  async userExists(username: string): Promise<boolean> {
    return this.users.has(username);
  }

  async getMergeRequest(): Promise<MergeRequestInfo> {
    return structuredClone(this.mr);
  }

  async findOpenMergeRequest(): Promise<MergeRequestInfo | null> {
    return structuredClone(this.openMr);
  }

  async listDiscussions(): Promise<MrDiscussion[]> {
    return structuredClone(this.discussions);
  }

  async createNote(_project: number | string, _iid: number, body: string): Promise<void> {
    this.notes.push(body);
    this.addDiscussion(BOT, body, { resolvable: false });
  }

  async replyToDiscussion(_project: number | string, _iid: number, discussionId: string, body: string): Promise<void> {
    this.replies.push({ discussionId, body });
    this.discussions.find((item) => item.id === discussionId)?.notes.push({
      id: this.nextId++, body, author: BOT, system: false, resolvable: true, resolved: false,
      type: null, createdAt: "2026-10-27T10:00:00Z", updatedAt: "2026-10-27T10:00:00Z", position: null,
    });
  }

  async resolveDiscussion(_project: number | string, _iid: number, discussionId: string): Promise<void> {
    this.resolved.push(discussionId);
    const discussion = this.discussions.find((item) => item.id === discussionId);
    for (const note of discussion?.notes ?? []) note.resolved = true;
  }

  async failedJobs(): Promise<FailedJob[]> {
    return structuredClone(this.failed);
  }

  async jobTraceTail(_project: number | string, jobId: number, lines: number): Promise<string> {
    return (this.traces.get(jobId) ?? "").replace(/\n+$/, "").split("\n").slice(-lines).join("\n");
  }
}
