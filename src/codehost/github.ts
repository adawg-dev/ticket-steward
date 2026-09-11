import { Octokit, type RestEndpointMethodTypes } from "@octokit/rest";
import { mergeChangeRefs } from "./dedupe.js";
import type { ChangeRef, CodeHost } from "./types.js";

type ListPulls = RestEndpointMethodTypes["repos"]["listPullRequestsAssociatedWithCommit"];
type GetCommit = RestEndpointMethodTypes["repos"]["getCommit"];

export interface GitHubReposApi {
  listPullRequestsAssociatedWithCommit(params: ListPulls["parameters"]): Promise<ListPulls["response"]>;
  getCommit(params: GetCommit["parameters"]): Promise<GetCommit["response"]>;
}

export interface GitHubCodeHostOptions {
  owner: string;
  repo: string;
  token?: string | undefined;
  client?: GitHubReposApi;
}

export class GitHubCodeHost implements CodeHost {
  readonly kind = "github" as const;
  private readonly owner: string;
  private readonly repo: string;
  private readonly client: GitHubReposApi;

  constructor(opts: GitHubCodeHostOptions) {
    this.owner = opts.owner;
    this.repo = opts.repo;
    this.client = opts.client ?? new Octokit({ auth: opts.token }).rest.repos;
  }

  permalink(path: string, sha: string, line?: number): string {
    const base = `https://github.com/${this.owner}/${this.repo}/blob/${sha}/${path}`;
    return line === undefined ? base : `${base}#L${line}`;
  }

  async changesForCommits(shas: string[]): Promise<ChangeRef[]> {
    const refs: ChangeRef[] = [];
    for (const sha of shas) {
      const { data: pulls } = await this.client.listPullRequestsAssociatedWithCommit({
        owner: this.owner,
        repo: this.repo,
        commit_sha: sha,
      });
      if (pulls.length === 0) {
        refs.push(await this.commitRef(sha));
        continue;
      }
      for (const pr of pulls) {
        refs.push({
          kind: "merge_request",
          id: String(pr.number),
          title: pr.title,
          url: pr.html_url,
          author: pr.user?.login ?? "",
          at: pr.merged_at ?? pr.created_at,
          shas: [sha],
        });
      }
    }
    return mergeChangeRefs(refs);
  }

  private async commitRef(sha: string): Promise<ChangeRef> {
    const { data } = await this.client.getCommit({ owner: this.owner, repo: this.repo, ref: sha });
    return {
      kind: "commit",
      id: data.sha,
      title: data.commit.message.split("\n")[0] ?? "",
      url: data.html_url,
      author: data.commit.author?.name ?? "",
      at: data.commit.author?.date ?? "",
      shas: [sha],
    };
  }
}
