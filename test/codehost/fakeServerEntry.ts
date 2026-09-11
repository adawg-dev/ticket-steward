import { startCodeHostMcpServer } from "../../src/codehost/server.js";
import type { ChangeRef, CodeHost } from "../../src/codehost/types.js";

const fakeCodeHost: CodeHost = {
  kind: "gitlab",
  permalink: (path, sha, line) => `https://fake.example/blob/${sha}/${path}${line === undefined ? "" : `#L${line}`}`,
  changesForCommits: async (shas): Promise<ChangeRef[]> =>
    shas.map((sha) => ({
      kind: "commit",
      id: sha,
      title: `commit ${sha}`,
      url: `https://fake.example/commit/${sha}`,
      author: "Fake",
      at: "2026-09-01T00:00:00Z",
      shas: [sha],
    })),
};

const [worktreePath = "", sha = ""] = process.argv.slice(2);
await startCodeHostMcpServer({ codehost: fakeCodeHost, worktreePath, sha });
