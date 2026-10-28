import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { RunSpec } from "../../src/run/protocol.js";
import { postWork, toolsWork } from "../../src/tools/finish.js";
import { commitFile, git, makeSourceRepo, removeDir, tmpDir } from "../workspace/helpers.js";

let root: string;
let worktree: string;
let start: string;

const specAt = (sha: string): RunSpec => ({
  version: 1,
  runId: "7-1",
  jobId: 7,
  kind: "implement",
  identifier: "API-1",
  issueId: "issue-1",
  checkout: { ref: null, sha },
  baseSha: sha,
  worktreePath: worktree,
  artifactsDir: join(root, "artifacts"),
  transcriptPath: join(root, "transcript.jsonl"),
  prompt: "",
  personCommits: null,
  output: "implement",
  resumeSessionId: null,
  limits: { timeoutMinutes: 60, maxTurns: 200, setupTimeoutMinutes: 20 },
  push: null,
  setup: [],
  checks: [],
  interactive: false,
});

beforeEach(async () => {
  root = await tmpDir();
  const { repo } = await makeSourceRepo(root);
  worktree = join(root, "work", "ticket-API-1");
  await mkdir(join(root, "work"));
  await git(root, ["clone", "-q", repo, worktree]);
  start = await git(worktree, ["rev-parse", "HEAD"]);
});

afterEach(async () => {
  await removeDir(root);
});

describe("toolsWork", () => {
  it("reports commits after the start and uncommitted paths, leaving out the steward's files", async () => {
    await commitFile(worktree, "src/a.ts", "a\n");
    await writeFile(join(worktree, "notes.md"), "draft\n");
    await writeFile(join(worktree, ".env"), "KEY=x\n");

    const work = await toolsWork({ spec: specAt(start), pushedSha: null, guard: () => Promise.resolve({ stewardFiles: [".env"], secrets: [] }) });

    expect(work.runId).toBe("7-1");
    expect(work.pushedSha).toBeNull();
    expect(work.unpushed).toContain("uncommitted:\n  notes.md");
    expect(work.unpushed).toContain("add src/a.ts");
    expect(work.unpushed).not.toContain(".env");
  });

  it("is empty after a push of everything", async () => {
    const sha = await commitFile(worktree, "src/a.ts", "a\n");

    expect(await toolsWork({ spec: specAt(start), pushedSha: sha, guard: () => Promise.resolve({ stewardFiles: [], secrets: [] }) })).toEqual({ runId: "7-1", unpushed: "", pushedSha: sha });
  });

  it("counts a worktree it cannot read as unpushed work", async () => {
    await removeDir(worktree);

    const work = await toolsWork({ spec: specAt(start), pushedSha: null, guard: () => Promise.resolve({ stewardFiles: [], secrets: [] }) });

    expect(work.unpushed).toMatch(/^the worktree could not be read: /);
  });
});

describe("postWork", () => {
  let server: Server;
  let baseUrl: string;
  let status: number;
  const seen: Array<{ url: string; authorization: string | undefined; body: string }> = [];

  beforeEach(async () => {
    status = 204;
    seen.length = 0;
    server = createServer((req, res) => {
      let body = "";
      req.on("data", (chunk: Buffer) => (body += chunk.toString("utf8")));
      req.on("end", () => {
        seen.push({ url: req.url ?? "", authorization: req.headers.authorization, body });
        res.writeHead(status).end();
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("posts the report to the run's work route with the tools token", async () => {
    const work = { runId: "7-1", unpushed: "", pushedSha: null };

    await postWork({ baseUrl, token: "tools-token-value", work });

    expect(seen).toEqual([{ url: "/internal/runs/7-1/work", authorization: "Bearer tools-token-value", body: JSON.stringify(work) }]);
  });

  it("surfaces a 401 as the tools token being rejected", async () => {
    status = 401;

    await expect(postWork({ baseUrl, token: "tools-token-value", work: { runId: "7-1", unpushed: "", pushedSha: null } })).rejects.toThrow("the run's tools token was rejected");
  });
});
