import { AuthenticationLinearError, type LinearClient } from "@linear/sdk";
import { createLinearClient, LinearApiKeyRejectedError, LinearTracker } from "../../../src/tracker/linear/client.js";

const API_KEY = "lin_api_test_key";

const updateIssueMock = vi.fn<LinearClient["updateIssue"]>();
const issueMock = vi.fn<LinearClient["issue"]>();
const issueAddLabelMock = vi.fn<LinearClient["issueAddLabel"]>();
const issueRemoveLabelMock = vi.fn<LinearClient["issueRemoveLabel"]>();
const issueLabelsMock = vi.fn<LinearClient["issueLabels"]>();
const clientFactoryMock = vi.fn<(apiKey: string) => LinearClient>();

const fakeClient = {
  updateIssue: updateIssueMock,
  issue: issueMock,
  issueAddLabel: issueAddLabelMock,
  issueRemoveLabel: issueRemoveLabelMock,
  issueLabels: issueLabelsMock,
} as unknown as LinearClient;

const okPayload = { success: true, lastSyncId: 1 };
const makeTracker = () => new LinearTracker(API_KEY, { clientFactory: clientFactoryMock });

/** An issue carrying `needs-triage`, whose team has its own `needs-info` label: a swap between them is one update. */
const mockSwappableIssue = (): void => {
  issueMock.mockResolvedValue({
    labels: async () => ({ nodes: [{ id: "l-triage", name: "needs-triage" }] }),
    team: Promise.resolve({ id: "team-1" }),
  } as never);
  issueLabelsMock.mockResolvedValue({
    nodes: [
      { id: "l-info-workspace", team: undefined },
      { id: "l-info-team", team: Promise.resolve({ id: "team-1" }) },
    ],
  } as never);
};

describe("createLinearClient", () => {
  it("sends the personal API key as a raw Authorization header, without Bearer", () => {
    expect(createLinearClient(API_KEY).options.headers).toMatchObject({ Authorization: API_KEY });
  });
});

describe("LinearTracker", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.clearAllMocks();
    clientFactoryMock.mockReturnValue(fakeClient);
    updateIssueMock.mockResolvedValue(okPayload as never);
    mockSwappableIssue();
  });

  it("builds one client from the API key", async () => {
    const tracker = makeTracker();
    await tracker.swapLabel("issue-uuid-1", "needs-triage", "needs-info");
    await tracker.swapLabel("issue-uuid-1", "needs-triage", "needs-info");
    expect(clientFactoryMock.mock.calls).toEqual([[API_KEY]]);
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

  it("reports an API key Linear accepts as not rejected", async () => {
    const tracker = makeTracker();
    await tracker.swapLabel("issue-uuid-1", "needs-triage", "needs-info");
    expect(tracker.apiKeyRejected()).toBe(false);
  });

  it("fails a write on 401 with an invalid-key error, without retrying, and latches the rejection", async () => {
    updateIssueMock.mockRejectedValue(new AuthenticationLinearError({ message: "unauthorized" }));
    const tracker = makeTracker();

    const write = tracker.swapLabel("issue-uuid-1", "needs-triage", "needs-info");

    await expect(write).rejects.toBeInstanceOf(LinearApiKeyRejectedError);
    await expect(write).rejects.toThrow("Linear rejected LINEAR_API_KEY (401): the key is invalid or revoked");
    expect(updateIssueMock).toHaveBeenCalledTimes(1);
    expect(tracker.apiKeyRejected()).toBe(true);
  });

  it("fails a read on 401 with an invalid-key error", async () => {
    issueMock.mockRejectedValue(new AuthenticationLinearError({ message: "unauthorized" }));
    const tracker = makeTracker();

    await expect(tracker.readDescription("issue-uuid-1")).rejects.toBeInstanceOf(LinearApiKeyRejectedError);
    expect(issueMock).toHaveBeenCalledTimes(1);
    expect(tracker.apiKeyRejected()).toBe(true);
  });

  it("does not latch the rejection for other errors", async () => {
    issueMock.mockRejectedValue(new Error("boom"));
    const tracker = makeTracker();
    await expect(tracker.readDescription("issue-uuid-1")).rejects.toThrow("boom");
    expect(tracker.apiKeyRejected()).toBe(false);
  });

  it("retries a failing write three times before surfacing the error", async () => {
    updateIssueMock.mockRejectedValue(new Error("boom"));
    await expect(makeTracker().swapLabel("issue-uuid-1", "needs-triage", "needs-info")).rejects.toThrow();
    expect(updateIssueMock).toHaveBeenCalledTimes(3);
  });

  it("succeeds when a write fails once then recovers", async () => {
    updateIssueMock.mockRejectedValueOnce(new Error("boom"));
    await makeTracker().swapLabel("issue-uuid-1", "needs-triage", "needs-info");
    expect(updateIssueMock).toHaveBeenCalledTimes(2);
  });

  it("has no comment, description or upload writes: labels are its only Linear writes", () => {
    const tracker: object = makeTracker();
    expect(["postComment", "writeDescription", "uploadFile"].filter((method) => method in tracker)).toEqual([]);
  });
});

describe("LinearTracker.swapLabel", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clientFactoryMock.mockReturnValue(fakeClient);
    updateIssueMock.mockResolvedValue(okPayload as never);
    mockSwappableIssue();
  });

  it("adds the team label and removes the old one in a single update", async () => {
    await makeTracker().swapLabel("issue-1", "Needs-Triage", "needs-info");
    expect(issueLabelsMock).toHaveBeenCalledWith({ filter: { name: { eqIgnoreCase: "needs-info" } } });
    expect(updateIssueMock).toHaveBeenCalledTimes(1);
    expect(updateIssueMock).toHaveBeenCalledWith("issue-1", { addedLabelIds: ["l-info-team"], removedLabelIds: ["l-triage"] });
    expect(issueAddLabelMock).not.toHaveBeenCalled();
    expect(issueRemoveLabelMock).not.toHaveBeenCalled();
  });

  it("falls back to the workspace label", async () => {
    issueLabelsMock.mockResolvedValue({ nodes: [{ id: "l-info-workspace", team: undefined }] } as never);
    await makeTracker().swapLabel("issue-1", "needs-triage", "needs-info");
    expect(updateIssueMock).toHaveBeenCalledWith("issue-1", { addedLabelIds: ["l-info-workspace"], removedLabelIds: ["l-triage"] });
  });

  it("fails when the target label does not exist", async () => {
    issueLabelsMock.mockResolvedValue({ nodes: [] } as never);
    await expect(makeTracker().swapLabel("issue-1", "needs-triage", "needs-info")).rejects.toThrow(
      'Linear label "needs-info" does not exist for this team or the workspace',
    );
    expect(updateIssueMock).not.toHaveBeenCalled();
  });

  it("skips the removal when the old label is absent", async () => {
    await makeTracker().swapLabel("issue-1", "ready-for-agent", "needs-info");
    expect(updateIssueMock).toHaveBeenCalledWith("issue-1", { addedLabelIds: ["l-info-team"], removedLabelIds: [] });
  });

  it("only removes the old label when the target is already on the issue", async () => {
    issueMock.mockResolvedValue({
      labels: async () => ({ nodes: [{ id: "l-triage", name: "needs-triage" }, { id: "l-info-team", name: "needs-info" }] }),
      team: Promise.resolve({ id: "team-1" }),
    } as never);
    await makeTracker().swapLabel("issue-1", "needs-triage", "needs-info");
    expect(updateIssueMock).toHaveBeenCalledWith("issue-1", { addedLabelIds: [], removedLabelIds: ["l-triage"] });
  });

  it("writes nothing when the swap is already done", async () => {
    issueMock.mockResolvedValue({
      labels: async () => ({ nodes: [{ id: "l-info-team", name: "needs-info" }] }),
      team: Promise.resolve({ id: "team-1" }),
    } as never);
    await makeTracker().swapLabel("issue-1", "needs-triage", "needs-info");
    expect(updateIssueMock).not.toHaveBeenCalled();
  });
});
