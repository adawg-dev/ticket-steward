import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AuthenticationLinearError, type LinearClient } from "@linear/sdk";
import { LinearAuth } from "../../../src/tracker/linear/auth.js";
import { LinearTracker } from "../../../src/tracker/linear/client.js";

const accessTokenMock = vi.fn<LinearAuth["accessToken"]>();
const handleUnauthorizedMock = vi.fn<LinearAuth["handleUnauthorized"]>();
const auth = { accessToken: accessTokenMock, handleUnauthorized: handleUnauthorizedMock } as unknown as LinearAuth;

const updateIssueMock = vi.fn<LinearClient["updateIssue"]>();
const createCommentMock = vi.fn<LinearClient["createComment"]>();
const createAgentActivityMock = vi.fn<LinearClient["createAgentActivity"]>();
const fileUploadMock = vi.fn<LinearClient["fileUpload"]>();
const issueMock = vi.fn<LinearClient["issue"]>();
const clientFactoryMock = vi.fn<(token: string) => LinearClient>();

const fakeClient = {
  updateIssue: updateIssueMock,
  createComment: createCommentMock,
  createAgentActivity: createAgentActivityMock,
  fileUpload: fileUploadMock,
  issue: issueMock,
} as unknown as LinearClient;

const okPayload = { success: true, lastSyncId: 1 };
const makeTracker = (fetchImpl: typeof fetch = vi.fn<typeof fetch>()) =>
  new LinearTracker(auth, { fetchImpl, clientFactory: clientFactoryMock });

describe("LinearTracker", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.clearAllMocks();
    accessTokenMock.mockResolvedValue("token-1");
    handleUnauthorizedMock.mockResolvedValue("token-2");
    clientFactoryMock.mockReturnValue(fakeClient);
    updateIssueMock.mockResolvedValue(okPayload as never);
    createCommentMock.mockResolvedValue(okPayload as never);
    createAgentActivityMock.mockResolvedValue(okPayload as never);
  });

  it("writes a description with updateIssue using the current access token", async () => {
    await makeTracker().writeDescription("issue-uuid-1", "new body");
    expect(clientFactoryMock).toHaveBeenCalledWith("token-1");
    expect(updateIssueMock).toHaveBeenCalledTimes(1);
    expect(updateIssueMock).toHaveBeenCalledWith("issue-uuid-1", { description: "new body" });
  });

  it("posts a comment with createComment", async () => {
    await makeTracker().postComment("issue-uuid-1", "hello");
    expect(createCommentMock).toHaveBeenCalledTimes(1);
    expect(createCommentMock).toHaveBeenCalledWith({ issueId: "issue-uuid-1", body: "hello" });
  });

  it("emits thought, response and error agent activities", async () => {
    const tracker = makeTracker();
    await tracker.agentSession.thought("session-1", "thinking");
    await tracker.agentSession.response("session-1", "done");
    await tracker.agentSession.error("session-1", "oops");
    expect(createAgentActivityMock.mock.calls).toEqual([
      [{ agentSessionId: "session-1", content: { type: "thought", body: "thinking" } }],
      [{ agentSessionId: "session-1", content: { type: "response", body: "done" } }],
      [{ agentSessionId: "session-1", content: { type: "error", body: "oops" } }],
    ]);
  });

  it("uploads a file via fileUpload then PUTs it with the returned headers", async () => {
    const dir = mkdtempSync(join(tmpdir(), "steward-upload-"));
    const path = join(dir, "shot.png");
    writeFileSync(path, Buffer.from([1, 2, 3, 4]));
    fileUploadMock.mockResolvedValue({
      success: true,
      lastSyncId: 1,
      uploadFile: {
        uploadUrl: "https://upload.example/put",
        assetUrl: "https://uploads.linear.app/asset/shot.png",
        headers: [{ key: "x-amz-meta", value: "abc" }],
      },
    } as never);
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 200 }));

    expect(await makeTracker(fetchMock).uploadFile(path, "image/png")).toEqual({ url: "https://uploads.linear.app/asset/shot.png" });

    expect(fileUploadMock).toHaveBeenCalledTimes(1);
    expect(fileUploadMock).toHaveBeenCalledWith("image/png", "shot.png", 4);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("https://upload.example/put");
    expect(init?.method).toBe("PUT");
    const headers = new Headers(init?.headers);
    expect(headers.get("x-amz-meta")).toBe("abc");
    expect(headers.get("content-type")).toBe("image/png");
    expect(headers.get("cache-control")).toBe("public, max-age=31536000");
    expect(Buffer.from(init?.body as Uint8Array)).toEqual(Buffer.from([1, 2, 3, 4]));
  });

  it("rejects an upload when the PUT is not 2xx", async () => {
    const dir = mkdtempSync(join(tmpdir(), "steward-upload-"));
    const path = join(dir, "shot.png");
    writeFileSync(path, "x");
    fileUploadMock.mockResolvedValue({
      success: true,
      lastSyncId: 1,
      uploadFile: { uploadUrl: "https://upload.example/put", assetUrl: "https://uploads.linear.app/a", headers: [] },
    } as never);
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 403 }));
    await expect(makeTracker(fetchMock).uploadFile(path, "image/png")).rejects.toThrow();
  });

  it("reads the description from the issue", async () => {
    issueMock.mockResolvedValue({ id: "issue-uuid-1", description: "current body" } as never);
    expect(await makeTracker().readDescription("issue-uuid-1")).toBe("current body");
    expect(issueMock).toHaveBeenCalledWith("issue-uuid-1");
  });

  it("reads an empty description when the issue has none", async () => {
    issueMock.mockResolvedValue({ id: "issue-uuid-1", description: null } as never);
    expect(await makeTracker().readDescription("issue-uuid-1")).toBe("");
  });

  it("resolves a key to id, identifier and team key", async () => {
    issueMock.mockResolvedValue({ id: "issue-uuid-1", identifier: "API-42", team: Promise.resolve({ key: "API" }) } as never);
    expect(await makeTracker().resolveIssueId("API-42")).toEqual({ id: "issue-uuid-1", identifier: "API-42", teamKey: "API" });
    expect(issueMock).toHaveBeenCalledWith("API-42");
  });

  it("refreshes once on 401 and retries with the new token", async () => {
    updateIssueMock.mockRejectedValueOnce(new AuthenticationLinearError({ message: "unauthorized" }));
    await makeTracker().writeDescription("issue-uuid-1", "body");
    expect(handleUnauthorizedMock).toHaveBeenCalledTimes(1);
    expect(clientFactoryMock.mock.calls).toEqual([["token-1"], ["token-2"]]);
    expect(updateIssueMock).toHaveBeenCalledTimes(2);
  });

  it("retries a failing write three times before surfacing the error", async () => {
    createCommentMock.mockRejectedValue(new Error("boom"));
    await expect(makeTracker().postComment("issue-uuid-1", "hello")).rejects.toThrow();
    expect(createCommentMock).toHaveBeenCalledTimes(3);
  });

  it("succeeds when a write fails once then recovers", async () => {
    createCommentMock.mockRejectedValueOnce(new Error("boom"));
    await makeTracker().postComment("issue-uuid-1", "hello");
    expect(createCommentMock).toHaveBeenCalledTimes(2);
  });
});
