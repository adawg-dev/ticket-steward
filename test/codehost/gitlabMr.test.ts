import { GitLabApiError, GitLabMrClient } from "../../src/codehost/gitlabMr.js";

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

const reply = (status: number, body: unknown, headers: Record<string, string> = {}): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

const recorder = (responses: Response[]) => {
  const calls: Call[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    calls.push({
      url: String(input),
      method: init?.method ?? "GET",
      headers: Object.fromEntries(new Headers(init?.headers).entries()),
      body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
    });
    const next = responses.shift();
    if (next === undefined) throw new Error("unexpected request");
    return next;
  };
  return { calls, fetchImpl };
};

const mrBody = {
  project_id: 42, iid: 7, state: "opened", sha: "c".repeat(40), title: "Fix", description: null,
  web_url: "https://gitlab.example/acme/repo/-/merge_requests/7", source_branch: "api-1-fix", target_branch: "main",
  updated_at: "2026-10-27T10:00:00Z",
  head_pipeline: { id: 9, sha: "c".repeat(40), status: "failed" },
};

const client = (fetchImpl: typeof fetch, extra: { sleep?: (ms: number) => Promise<void> } = {}): GitLabMrClient =>
  new GitLabMrClient({ baseUrl: "https://g", token: "t", fetchImpl, ...extra });

describe("GitLabMrClient", () => {
  it("reads a merge request with the private token and maps the head pipeline", async () => {
    const { calls, fetchImpl } = recorder([reply(200, mrBody)]);
    const mr = await new GitLabMrClient({ baseUrl: "https://gitlab.example/", token: "glpat-test", fetchImpl }).getMergeRequest(42, 7);
    expect(mr).toEqual({
      projectId: 42, iid: 7, state: "opened", sha: "c".repeat(40), title: "Fix", description: "",
      webUrl: mrBody.web_url, sourceBranch: "api-1-fix", targetBranch: "main", updatedAt: "2026-10-27T10:00:00Z",
      headPipeline: { id: 9, sha: "c".repeat(40), status: "failed" },
    });
    expect(calls[0]).toMatchObject({ url: "https://gitlab.example/api/v4/projects/42/merge_requests/7", method: "GET", headers: { "private-token": "glpat-test" } });
  });

  it("maps a missing head pipeline to null", async () => {
    const { fetchImpl } = recorder([reply(200, { ...mrBody, head_pipeline: null })]);
    expect((await client(fetchImpl).getMergeRequest(42, 7)).headPipeline).toBeNull();
  });

  it("finds the open merge request of a branch by URL-encoded project path", async () => {
    const { calls, fetchImpl } = recorder([reply(200, []), reply(200, [mrBody, { ...mrBody, iid: 8 }])]);
    const c = client(fetchImpl);
    expect(await c.findOpenMergeRequest("concentrateai/kickoff", "fix/API-1-x")).toBeNull();
    expect((await c.findOpenMergeRequest("concentrateai/kickoff", "fix/API-1-x"))?.iid).toBe(7);
    expect(calls[0]?.url).toBe("https://g/api/v4/projects/concentrateai%2Fkickoff/merge_requests?state=opened&source_branch=fix%2FAPI-1-x");
  });

  it("follows discussion pages and maps note type, timestamps and position", async () => {
    const note = {
      id: 1, body: "b", author: { username: "steward-bot" }, system: false, resolvable: true, resolved: false,
      type: "DiffNote", created_at: "2026-10-27T10:00:00Z", updated_at: "2026-10-27T11:00:00Z",
      position: { new_path: "src/x.ts", old_path: "src/y.ts", new_line: 12, old_line: null },
    };
    const plain = { id: 2, body: "c", author: { username: "u" }, system: true, type: null, created_at: "t1", updated_at: "t2" };
    const { calls, fetchImpl } = recorder([reply(200, [{ id: "d1", notes: [note] }], { "x-next-page": "2" }), reply(200, [{ id: "d2", notes: [plain] }], { "x-next-page": "" })]);
    const discussions = await client(fetchImpl).listDiscussions(42, 7);
    expect(discussions.map((d) => d.id)).toEqual(["d1", "d2"]);
    expect(discussions[0]?.notes[0]).toEqual({
      id: 1, body: "b", author: "steward-bot", system: false, resolvable: true, resolved: false, type: "DiffNote",
      createdAt: "2026-10-27T10:00:00Z", updatedAt: "2026-10-27T11:00:00Z",
      position: { newPath: "src/x.ts", oldPath: "src/y.ts", newLine: 12, oldLine: null },
    });
    expect(discussions[1]?.notes[0]).toMatchObject({ type: null, position: null, resolvable: false, resolved: false });
    expect(calls.map((c) => c.url)).toEqual([
      "https://g/api/v4/projects/42/merge_requests/7/discussions?per_page=100&page=1",
      "https://g/api/v4/projects/42/merge_requests/7/discussions?per_page=100&page=2",
    ]);
  });

  it("collects failed jobs of the pipeline and its downstream pipelines, parent first", async () => {
    const job = (id: number, name: string) => ({ id, name, stage: "test", web_url: `https://g/jobs/${id}`, failure_reason: id === 1 ? "runner_system_failure" : undefined });
    const { calls, fetchImpl } = recorder([
      reply(200, [job(1, "unit")]),
      reply(200, [{ id: 50, downstream_pipeline: { id: 2 } }, { id: 51, downstream_pipeline: null }]),
      reply(200, [job(2, "e2e")]),
      reply(200, []),
    ]);
    const jobs = await client(fetchImpl).failedJobs(42, 1);
    expect(jobs).toEqual([
      { id: 1, name: "unit", stage: "test", webUrl: "https://g/jobs/1", failureReason: "runner_system_failure" },
      { id: 2, name: "e2e", stage: "test", webUrl: "https://g/jobs/2", failureReason: null },
    ]);
    const urls = calls.map((c) => c.url);
    expect(urls[0]).toContain("/projects/42/pipelines/1/jobs?scope[]=failed");
    expect(urls[1]).toContain("/projects/42/pipelines/1/bridges");
    expect(urls[2]).toContain("/projects/42/pipelines/2/jobs?scope[]=failed");
    expect(urls[3]).toContain("/projects/42/pipelines/2/bridges");
  });

  it("stops following downstream pipelines at depth 3", async () => {
    const bridge = (next: number) => reply(200, [{ id: next, downstream_pipeline: { id: next } }]);
    const { calls, fetchImpl } = recorder([
      reply(200, []), bridge(2), reply(200, []), bridge(3), reply(200, []), bridge(4), reply(200, []),
    ]);
    await client(fetchImpl).failedJobs(42, 1);
    expect(calls.map((c) => c.url).filter((u) => u.includes("/jobs?"))).toHaveLength(4);
    expect(calls).toHaveLength(7);
  });

  it("returns the last lines of a job trace as text", async () => {
    const { calls, fetchImpl } = recorder([new Response("a\nb\nc\n", { status: 200 })]);
    expect(await client(fetchImpl).jobTraceTail(42, 5, 2)).toBe("b\nc");
    expect(calls[0]?.url).toBe("https://g/api/v4/projects/42/jobs/5/trace");
  });

  it("checks whether a user exists", async () => {
    const { calls, fetchImpl } = recorder([reply(200, [{ id: 1, username: "greptile-bot" }]), reply(200, [])]);
    const c = client(fetchImpl);
    expect(await c.userExists("greptile-bot")).toBe(true);
    expect(await c.userExists("greptile-bot")).toBe(false);
    expect(calls[0]?.url).toBe("https://g/api/v4/users?username=greptile-bot");
  });

  it("reads a member's access level, inherited membership included, and null for a non-member", async () => {
    const { calls, fetchImpl } = recorder([reply(200, { id: 5, username: "ada", access_level: 30 }), reply(404, { message: "404 Not found" })]);
    const c = client(fetchImpl);
    expect(await c.memberAccessLevel(42, 5)).toBe(30);
    expect(await c.memberAccessLevel(42, 6)).toBeNull();
    expect(calls[0]?.url).toBe("https://g/api/v4/projects/42/members/all/5");
  });

  it("retries after a 429 and throws GitLabApiError with the status otherwise", async () => {
    const waits: number[] = [];
    const { fetchImpl } = recorder([reply(429, {}, { "retry-after": "2" }), reply(201, {}), reply(400, { message: "bad" })]);
    const c = client(fetchImpl, { sleep: async (ms) => void waits.push(ms) });
    await c.createNote(42, 7, "summary");
    expect(waits).toEqual([2000]);
    await expect(c.createNote(42, 7, "again")).rejects.toMatchObject({ name: "GitLabApiError", status: 400 });
    expect(GitLabApiError).toBeDefined();
  });

  it("replies to and resolves a discussion and reads token scopes", async () => {
    const { calls, fetchImpl } = recorder([reply(201, {}), reply(200, {}), reply(200, { scopes: ["api", "read_repository"] })]);
    const c = client(fetchImpl);
    await c.replyToDiscussion("acme/repo", 7, "d1", "ok");
    await c.resolveDiscussion(42, 7, "d1");
    expect(await c.tokenScopes()).toEqual(["api", "read_repository"]);
    expect(calls.map((x) => `${x.method} ${x.url}`)).toEqual([
      "POST https://g/api/v4/projects/acme%2Frepo/merge_requests/7/discussions/d1/notes",
      "PUT https://g/api/v4/projects/42/merge_requests/7/discussions/d1?resolved=true",
      "GET https://g/api/v4/personal_access_tokens/self",
    ]);
  });

  it("uploads a file to the project as multipart and returns its Markdown", async () => {
    const seen: Array<{ url: string; method: string; contentType: string | null; file: { name: string; bytes: number } | null }> = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      const body = init?.body;
      const file = body instanceof FormData ? body.get("file") : null;
      seen.push({
        url: String(input),
        method: init?.method ?? "GET",
        contentType: new Headers(init?.headers).get("content-type"),
        file: file instanceof File ? { name: file.name, bytes: file.size } : null,
      });
      return reply(201, { alt: "after", url: "/uploads/abc/after.png", full_path: "/-/project/42/uploads/abc/after.png", markdown: "![after](/uploads/abc/after.png)" });
    };

    const uploaded = await client(fetchImpl).uploadFile("acme/repo", "after.png", new Uint8Array([1, 2, 3]));

    expect(uploaded).toEqual({ markdown: "![after](/uploads/abc/after.png)" });
    expect(seen).toEqual([{ url: "https://g/api/v4/projects/acme%2Frepo/uploads", method: "POST", contentType: null, file: { name: "after.png", bytes: 3 } }]);
  });

  it("retries a job", async () => {
    const { calls, fetchImpl } = recorder([reply(201, { id: 6 })]);
    await client(fetchImpl).retryJob(42, 5);
    expect(calls[0]).toMatchObject({ url: "https://g/api/v4/projects/42/jobs/5/retry", method: "POST" });
  });

  it("flattens a pipeline's test report into suite, test and status, the class name before the test's", async () => {
    const { calls, fetchImpl } = recorder([
      reply(200, {
        total_count: 3,
        test_suites: [
          { name: "unit", test_cases: [{ name: "flushes", classname: "adapter", status: "failed" }, { name: "opens", classname: null, status: "success" }] },
          { name: "e2e", test_cases: [{ name: "logs in", status: "error" }] },
        ],
      }),
    ]);
    expect(await client(fetchImpl).testReport(42, 9)).toEqual([
      { suite: "unit", name: "adapter flushes", status: "failed" },
      { suite: "unit", name: "opens", status: "success" },
      { suite: "e2e", name: "logs in", status: "error" },
    ]);
    expect(calls[0]?.url).toBe("https://g/api/v4/projects/42/pipelines/9/test_report");
  });

  it("lists a ref's pipelines updated since a time, newest first, one page", async () => {
    const { calls, fetchImpl } = recorder([reply(200, [{ id: 12, sha: "a", status: "failed", ref: "main" }, { id: 11, sha: "b", status: "success" }], { "x-next-page": "2" })]);
    expect(await client(fetchImpl).recentPipelines(42, "main", "2026-10-15T12:00:00.000Z")).toEqual([
      { id: 12, sha: "a", status: "failed" },
      { id: 11, sha: "b", status: "success" },
    ]);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe(
      "https://g/api/v4/projects/42/pipelines?ref=main&updated_after=2026-10-15T12%3A00%3A00.000Z&order_by=id&sort=desc&per_page=100",
    );
  });
});
