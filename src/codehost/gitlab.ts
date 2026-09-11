import { Gitlab, type Commits } from "@gitbeaker/rest";
import { mergeChangeRefs } from "./dedupe.js";
import type { ChangeRef, CodeHost } from "./types.js";

export type GitLabCommitsApi = Pick<Commits, "allMergeRequests" | "show">;

export interface GitLabCodeHostOptions {
  baseUrl: string;
  project: string;
  token?: string | undefined;
  client?: GitLabCommitsApi;
}

export class GitLabCodeHost implements CodeHost {
  readonly kind = "gitlab" as const;
  private readonly baseUrl: string;
  private readonly project: string;
  private readonly client: GitLabCommitsApi;

  constructor(opts: GitLabCodeHostOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, "");
    this.project = opts.project;
    this.client = opts.client ?? new Gitlab({ host: this.baseUrl, token: opts.token ?? "" }).Commits;
  }

  permalink(path: string, sha: string, line?: number): string {
    const base = `${this.baseUrl}/${this.project}/-/blob/${sha}/${path}`;
    return line === undefined ? base : `${base}#L${line}`;
  }

  async changesForCommits(shas: string[]): Promise<ChangeRef[]> {
    const refs: ChangeRef[] = [];
    for (const sha of shas) {
      const mrs = await this.client.allMergeRequests(this.project, sha);
      if (mrs.length === 0) {
        refs.push(await this.commitRef(sha));
        continue;
      }
      for (const mr of mrs) {
        refs.push({
          kind: "merge_request",
          id: String(mr.iid),
          title: mr.title,
          url: mr.web_url,
          author: mr.author.name,
          at: mr.merged_at ?? mr.created_at,
          shas: [sha],
        });
      }
    }
    return mergeChangeRefs(refs);
  }

  private async commitRef(sha: string): Promise<ChangeRef> {
    const commit = await this.client.show(this.project, sha);
    return {
      kind: "commit",
      id: commit.id,
      title: commit.title,
      url: commit.web_url,
      author: commit.author_name,
      at: commit.created_at,
      shas: [sha],
    };
  }
}
