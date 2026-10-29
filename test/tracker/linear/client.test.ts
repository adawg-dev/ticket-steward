import { AuthenticationLinearError, type LinearClient } from "@linear/sdk";
import { LinearCredentialsRejectedError, type LinearToken } from "../../../src/tracker/linear/auth.js";
import { createLinearClient, LinearTracker } from "../../../src/tracker/linear/client.js";

const issueMock = vi.fn<LinearClient["issue"]>();
const viewerMock = vi.fn<() => Promise<{ id: string }>>();
const clientFactoryMock = vi.fn<(accessToken: string) => LinearClient>();

const fakeClient = {
  issue: issueMock,
  get viewer() {
    return viewerMock();
  },
} as unknown as LinearClient;

/** Hands out `token-1`, `token-2`, … : a new one after each invalidate of the current one. */
const fakeToken = () => {
  let current = 1;
  const token = {
    get: vi.fn<LinearToken["get"]>(async () => `token-${current}`),
    invalidate: vi.fn<LinearToken["invalidate"]>((rejected) => {
      if (rejected === `token-${current}`) current += 1;
    }),
    revoke: vi.fn<LinearToken["revoke"]>(async () => undefined),
  };
  return token;
};

let token = fakeToken();
const makeTracker = () => new LinearTracker(token, { clientFactory: clientFactoryMock });
const unauthorized = () => new AuthenticationLinearError({ message: "unauthorized" });

describe("createLinearClient", () => {
  it("sends the app's access token as a Bearer token", () => {
    expect(createLinearClient("token-1").options.headers).toMatchObject({ Authorization: "Bearer token-1" });
  });
});

describe("LinearTracker", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.clearAllMocks();
    token = fakeToken();
    clientFactoryMock.mockReturnValue(fakeClient);
    issueMock.mockResolvedValue({ id: "issue-uuid-1", description: "current body" } as never);
    viewerMock.mockResolvedValue({ id: "app-user-1" });
  });

  it("builds one client per access token", async () => {
    const tracker = makeTracker();
    await tracker.readDescription("issue-uuid-1");
    await tracker.readDescription("issue-uuid-1");
    expect(clientFactoryMock.mock.calls).toEqual([["token-1"]]);
  });

  it("reads the description from the issue", async () => {
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

  it("reads the app user's id from viewer once", async () => {
    const tracker = makeTracker();
    expect(await tracker.appUserId()).toBe("app-user-1");
    expect(await tracker.appUserId()).toBe("app-user-1");
    expect(viewerMock).toHaveBeenCalledTimes(1);
  });

  it("asks viewer again after a failed read", async () => {
    viewerMock.mockRejectedValueOnce(new Error("boom"));
    const tracker = makeTracker();
    await expect(tracker.appUserId()).rejects.toThrow("boom");
    expect(await tracker.appUserId()).toBe("app-user-1");
  });

  it("on a 401 invalidates the token, re-mints and retries once", async () => {
    issueMock.mockRejectedValueOnce(unauthorized());
    const tracker = makeTracker();

    expect(await tracker.readDescription("issue-uuid-1")).toBe("current body");

    expect(token.invalidate.mock.calls).toEqual([["token-1"]]);
    expect(clientFactoryMock.mock.calls).toEqual([["token-1"], ["token-2"]]);
    expect(issueMock).toHaveBeenCalledTimes(2);
    expect(tracker.credentialsRejected()).toBe(false);
  });

  it("latches the rejection on a second 401", async () => {
    issueMock.mockRejectedValue(unauthorized());
    const tracker = makeTracker();

    const read = tracker.readDescription("issue-uuid-1");

    await expect(read).rejects.toBeInstanceOf(LinearCredentialsRejectedError);
    expect(issueMock).toHaveBeenCalledTimes(2);
    expect(token.invalidate).toHaveBeenCalledTimes(2);
    expect(tracker.credentialsRejected()).toBe(true);
  });

  it("latches the rejection when Linear refuses to mint a token", async () => {
    token.get.mockRejectedValue(new LinearCredentialsRejectedError());
    const tracker = makeTracker();

    await expect(tracker.readDescription("issue-uuid-1")).rejects.toBeInstanceOf(LinearCredentialsRejectedError);
    expect(issueMock).not.toHaveBeenCalled();
    expect(tracker.credentialsRejected()).toBe(true);
  });

  it("does not latch the rejection for other errors", async () => {
    issueMock.mockRejectedValue(new Error("boom"));
    const tracker = makeTracker();
    await expect(tracker.readDescription("issue-uuid-1")).rejects.toThrow("boom");
    expect(issueMock).toHaveBeenCalledTimes(1);
    expect(tracker.credentialsRejected()).toBe(false);
  });

  it("has no label, comment, description or upload writes", () => {
    const tracker: object = makeTracker();
    expect(["swapLabel", "postComment", "writeDescription", "uploadFile"].filter((method) => method in tracker)).toEqual([]);
  });
});
