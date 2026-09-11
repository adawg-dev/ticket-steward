import type { ChangeRef, CodeHost } from "../../src/codehost/types.js";

export class FakeCodeHost implements CodeHost {
  readonly kind = "gitlab";

  permalink(path: string, sha: string, line?: number): string {
    return `https://fake.example/blob/${sha}/${path}${line === undefined ? "" : `#L${line}`}`;
  }

  async changesForCommits(shas: string[]): Promise<ChangeRef[]> {
    return shas.map((sha) => ({
      kind: "commit",
      id: sha,
      title: `commit ${sha}`,
      url: `https://fake.example/commit/${sha}`,
      author: "Fake",
      at: "2026-09-01T00:00:00Z",
      shas: [sha],
    }));
  }
}
