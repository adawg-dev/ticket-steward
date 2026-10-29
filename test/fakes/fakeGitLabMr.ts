import type { FailedJob, GitLabMrApi, MergeRequestInfo, MrDiscussion, PipelineRef, TestCase } from "../../src/codehost/gitlabMr.js";

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
  /** Job ids retryJob was called with, in order. */
  readonly retried: number[] = [];
  /** Test reports by pipeline id; a pipeline without one answers 404, as GitLab does. */
  testReports = new Map<number, TestCase[]>();
  /** What recentPipelines answers, by ref; the since time is recorded, not applied. */
  pipelines = new Map<string, PipelineRef[]>();
  readonly pipelineQueries: Array<{ ref: string; sinceIso: string }> = [];
  /** Job traces by job id; jobTraceTail returns the last lines of one. */
  traces = new Map<number, string>();
  /** Usernames userExists answers true for. */
  users = new Set<string>();
  scopes = ["api"];
  /** Access levels memberAccessLevel answers by user id; anyone else is not a member. */
  members = new Map<number, number>();
  readonly notes: string[] = [];
  readonly replies: Array<{ discussionId: string; body: string }> = [];
  readonly resolved: string[] = [];
  /** Files uploadFile received, by project and name. */
  readonly uploads: Array<{ project: number | string; filename: string; bytes: number }> = [];
  private failingUploads = 0;
  private nextId = 1;
  private failingNotes = 0;
  private failingReplies = 0;

  constructor(mr: MergeRequestInfo = fakeMergeRequest()) {
    this.mr = mr;
  }

  addDiscussion(author: string, body: string, opts: { resolvable?: boolean; resolved?: boolean; system?: boolean; createdAt?: string } = {}): string {
    const id = `d${this.nextId++}`;
    const createdAt = opts.createdAt ?? "2026-10-27T10:00:00Z";
    this.discussions.push({
      id,
      notes: [{
        id: this.nextId++, body, author, system: opts.system ?? false, resolvable: opts.resolvable ?? true, resolved: opts.resolved ?? false,
        type: null, createdAt, updatedAt: createdAt, position: null,
      }],
    });
    return id;
  }

  /** The next createNote throws, as GitLab being down would. */
  failNextNote(): void {
    this.failingNotes += 1;
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
    if (this.failingNotes > 0) {
      this.failingNotes -= 1;
      throw new Error("GitLab down");
    }
    this.notes.push(body);
    this.addDiscussion(BOT, body, { resolvable: false });
  }

  /** The next replyToDiscussion throws, as GitLab being down would. */
  failNextReply(): void {
    this.failingReplies += 1;
  }

  async replyToDiscussion(_project: number | string, _iid: number, discussionId: string, body: string): Promise<void> {
    if (this.failingReplies > 0) {
      this.failingReplies -= 1;
      throw new Error("GitLab down");
    }
    this.replies.push({ discussionId, body });
    this.discussions.find((item) => item.id === discussionId)?.notes.push({
      id: this.nextId++, body, author: BOT, system: false, resolvable: true, resolved: false,
      type: null, createdAt: "2026-10-27T10:00:00Z", updatedAt: "2026-10-27T10:00:00Z", position: null,
    });
  }

  async memberAccessLevel(_project: number | string, userId: number): Promise<number | null> {
    return this.members.get(userId) ?? null;
  }

  async resolveDiscussion(_project: number | string, _iid: number, discussionId: string): Promise<void> {
    this.resolved.push(discussionId);
    const discussion = this.discussions.find((item) => item.id === discussionId);
    for (const note of discussion?.notes ?? []) note.resolved = true;
  }

  async failedJobs(): Promise<FailedJob[]> {
    return structuredClone(this.failed);
  }

  async retryJob(_project: number | string, jobId: number): Promise<void> {
    this.retried.push(jobId);
  }

  async testReport(_project: number | string, pipelineId: number): Promise<TestCase[]> {
    const report = this.testReports.get(pipelineId);
    if (report === undefined) throw new Error(`GitLab GET test_report answered 404`);
    return structuredClone(report);
  }

  async recentPipelines(_project: number | string, ref: string, sinceIso: string): Promise<PipelineRef[]> {
    this.pipelineQueries.push({ ref, sinceIso });
    return structuredClone(this.pipelines.get(ref) ?? []);
  }

  async jobTraceTail(_project: number | string, jobId: number, lines: number): Promise<string> {
    return (this.traces.get(jobId) ?? "").replace(/\n+$/, "").split("\n").slice(-lines).join("\n");
  }

  /** The next uploadFile throws, as GitLab being down would. */
  failNextUpload(): void {
    this.failingUploads += 1;
  }

  async uploadFile(project: number | string, filename: string, data: Uint8Array): Promise<{ markdown: string }> {
    if (this.failingUploads > 0) {
      this.failingUploads -= 1;
      throw new Error("GitLab down");
    }
    this.uploads.push({ project, filename, bytes: data.length });
    return { markdown: `![${filename}](/uploads/${this.uploads.length}/${filename})` };
  }
}
