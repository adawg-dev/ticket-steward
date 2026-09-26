import { GitLabApiError, type DiffPosition, type GitLabReviewApi, type MergeRequestInfo, type ReviewDiscussion } from "../../src/codehost/gitlabReview.js";

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
  reviewers: [BOT],
  diffRefs: { baseSha: "a".repeat(40), startSha: "a".repeat(40), headSha: "c".repeat(40) },
  ...overrides,
});

/** In-memory GitLab: created discussions and notes appear in listDiscussions, like the real API. */
export class FakeGitLabReview implements GitLabReviewApi {
  mr: MergeRequestInfo;
  readonly discussions: ReviewDiscussion[] = [];
  readonly positions: Array<{ body: string; position: DiffPosition }> = [];
  readonly notes: string[] = [];
  readonly replies: Array<{ discussionId: string; body: string }> = [];
  readonly resolved: string[] = [];
  /** "path:newLine" or "path:old:oldLine" positions GitLab refuses with a 400. */
  readonly rejected = new Set<string>();
  scopes = ["api"];
  private nextId = 1;
  private createsBeforeFailure: number | null = null;

  constructor(mr: MergeRequestInfo = fakeMergeRequest()) {
    this.mr = mr;
  }

  /** The create call after `successes` more successful creates answers 500, once. */
  failCreateAfter(successes: number): void {
    this.createsBeforeFailure = successes;
  }

  addDiscussion(author: string, body: string, opts: { resolvable?: boolean; resolved?: boolean } = {}): string {
    const id = `d${this.nextId++}`;
    this.discussions.push({ id, notes: [{ id: this.nextId++, body, author, system: false, resolvable: opts.resolvable ?? true, resolved: opts.resolved ?? false }] });
    return id;
  }

  async currentUser(): Promise<{ username: string }> {
    return { username: BOT };
  }

  async tokenScopes(): Promise<string[]> {
    return [...this.scopes];
  }

  async getMergeRequest(): Promise<MergeRequestInfo> {
    return structuredClone(this.mr);
  }

  async listDiscussions(): Promise<ReviewDiscussion[]> {
    return structuredClone(this.discussions);
  }

  async createDiffDiscussion(_projectId: number, _iid: number, body: string, position: DiffPosition): Promise<void> {
    this.countCreate();
    const key = position.newLine === null ? `${position.oldPath}:old:${position.oldLine ?? 0}` : `${position.newPath}:${position.newLine}`;
    if (this.rejected.has(key)) throw new GitLabApiError(400, "400 Bad request - Note {:line_code=>[\"must be a valid line code\"]}");
    this.positions.push({ body, position });
    this.addDiscussion(BOT, body);
  }

  async createNote(_projectId: number, _iid: number, body: string): Promise<void> {
    this.countCreate();
    this.notes.push(body);
    this.addDiscussion(BOT, body, { resolvable: false });
  }

  async replyToDiscussion(_projectId: number, _iid: number, discussionId: string, body: string): Promise<void> {
    this.replies.push({ discussionId, body });
  }

  async resolveDiscussion(_projectId: number, _iid: number, discussionId: string): Promise<void> {
    this.resolved.push(discussionId);
    const discussion = this.discussions.find((item) => item.id === discussionId);
    for (const note of discussion?.notes ?? []) note.resolved = true;
  }

  private countCreate(): void {
    if (this.createsBeforeFailure === null) return;
    if (this.createsBeforeFailure === 0) {
      this.createsBeforeFailure = null;
      throw new GitLabApiError(500, "500 Internal Server Error");
    }
    this.createsBeforeFailure -= 1;
  }
}
