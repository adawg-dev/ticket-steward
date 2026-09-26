import { GitLabApiError, GitLabReviewClient } from "../../src/codehost/gitlabReview.js";

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
  reviewers: [{ id: 1, username: "steward-bot" }],
  diff_refs: { base_sha: "a".repeat(40), start_sha: "b".repeat(40), head_sha: "c".repeat(40) },
};

describe("GitLabReviewClient", () => {
  it("reads a merge request with the private token", async () => {
    const { calls, fetchImpl } = recorder([reply(200, mrBody)]);
    const client = new GitLabReviewClient({ baseUrl: "https://gitlab.example/", token: "glpat-test", fetchImpl });
    expect(await client.getMergeRequest(42, 7)).toEqual({
      projectId: 42, iid: 7, state: "opened", sha: "c".repeat(40), title: "Fix", description: "",
      webUrl: mrBody.web_url, sourceBranch: "api-1-fix", targetBranch: "main", reviewers: ["steward-bot"],
      diffRefs: { baseSha: "a".repeat(40), startSha: "b".repeat(40), headSha: "c".repeat(40) },
    });
    expect(calls[0]).toMatchObject({ url: "https://gitlab.example/api/v4/projects/42/merge_requests/7", method: "GET", headers: { "private-token": "glpat-test" } });
  });

  it("reports diff refs that are not populated yet as null", async () => {
    const { fetchImpl } = recorder([reply(200, { ...mrBody, diff_refs: { base_sha: null, start_sha: null, head_sha: null } })]);
    expect((await new GitLabReviewClient({ baseUrl: "https://g", token: "t", fetchImpl }).getMergeRequest(42, 7)).diffRefs).toBeNull();
  });

  it("follows discussion pages", async () => {
    const note = { id: 1, body: "b", author: { username: "steward-bot" }, system: false, resolvable: true, resolved: false };
    const { calls, fetchImpl } = recorder([reply(200, [{ id: "d1", notes: [note] }], { "x-next-page": "2" }), reply(200, [{ id: "d2", notes: [] }], { "x-next-page": "" })]);
    const discussions = await new GitLabReviewClient({ baseUrl: "https://g", token: "t", fetchImpl }).listDiscussions(42, 7);
    expect(discussions.map((d) => d.id)).toEqual(["d1", "d2"]);
    expect(discussions[0]?.notes[0]).toEqual({ id: 1, body: "b", author: "steward-bot", system: false, resolvable: true, resolved: false });
    expect(calls.map((c) => c.url)).toEqual([
      "https://g/api/v4/projects/42/merge_requests/7/discussions?per_page=100&page=1",
      "https://g/api/v4/projects/42/merge_requests/7/discussions?per_page=100&page=2",
    ]);
  });

  it("posts a text diff position with only the lines that are set", async () => {
    const { calls, fetchImpl } = recorder([reply(201, { id: "d" })]);
    await new GitLabReviewClient({ baseUrl: "https://g", token: "t", fetchImpl }).createDiffDiscussion(42, 7, "hi", {
      baseSha: "a", startSha: "b", headSha: "c", oldPath: "src/x.ts", newPath: "src/x.ts", oldLine: null, newLine: 12,
    });
    expect(calls[0]).toMatchObject({
      url: "https://g/api/v4/projects/42/merge_requests/7/discussions",
      method: "POST",
      body: { body: "hi", position: { position_type: "text", base_sha: "a", start_sha: "b", head_sha: "c", old_path: "src/x.ts", new_path: "src/x.ts", new_line: 12 } },
    });
  });

  it("retries after a 429 and throws GitLabApiError with the status otherwise", async () => {
    const waits: number[] = [];
    const { fetchImpl } = recorder([reply(429, {}, { "retry-after": "2" }), reply(201, {}), reply(400, { message: "line_code invalid" })]);
    const client = new GitLabReviewClient({ baseUrl: "https://g", token: "t", fetchImpl, sleep: async (ms) => void waits.push(ms) });
    await client.createNote(42, 7, "summary");
    expect(waits).toEqual([2000]);
    await expect(client.createNote(42, 7, "again")).rejects.toMatchObject({ name: "GitLabApiError", status: 400 });
    expect(GitLabApiError).toBeDefined();
  });

  it("resolves a discussion and reads token scopes", async () => {
    const { calls, fetchImpl } = recorder([reply(200, {}), reply(200, { scopes: ["api", "read_repository"] })]);
    const client = new GitLabReviewClient({ baseUrl: "https://g", token: "t", fetchImpl });
    await client.resolveDiscussion(42, 7, "d1");
    expect(await client.tokenScopes()).toEqual(["api", "read_repository"]);
    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      "PUT https://g/api/v4/projects/42/merge_requests/7/discussions/d1?resolved=true",
      "GET https://g/api/v4/personal_access_tokens/self",
    ]);
  });
});
