export interface ChangeRef {
  kind: "merge_request" | "commit";
  id: string;
  title: string;
  url: string;
  author: string;
  at: string;
  shas: string[];
}

export interface CodeHost {
  kind: "gitlab" | "github";
  permalink(path: string, sha: string, line?: number): string;
  changesForCommits(shas: string[]): Promise<ChangeRef[]>;
}
