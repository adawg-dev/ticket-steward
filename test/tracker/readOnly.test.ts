import { ReadOnlyTracker } from "../../src/tracker/readOnly.js";
import type { TicketBundle, Tracker } from "../../src/tracker/types.js";

const bundle: TicketBundle = {
  id: "issue-uuid-1",
  identifier: "API-42",
  url: "https://linear.app/acme/issue/API-42",
  title: "Broken thing",
  description: "Something is broken",
  team: { id: "team-1", key: "API", name: "API" },
  state: { name: "Triage", type: "triage" },
  labels: ["bug"],
  priority: 2,
  creator: { name: "Ada", isBot: false },
  createdAt: "2026-09-11T00:00:00.000Z",
  comments: [],
  attachments: [],
  appliedTemplate: null,
  templates: [],
};

const writeDescriptionMock = vi.fn<Tracker["writeDescription"]>();
const postCommentMock = vi.fn<Tracker["postComment"]>();
const uploadFileMock = vi.fn<Tracker["uploadFile"]>();
const apiKeyRejectedMock = vi.fn<Tracker["apiKeyRejected"]>();

const inner: Tracker = {
  kind: "linear",
  resolveIssueId: async () => ({ id: "issue-uuid-1", identifier: "API-42", teamKey: "API" }),
  fetchTicket: async () => bundle,
  readDescription: async () => "Something is broken",
  writeDescription: writeDescriptionMock,
  postComment: postCommentMock,
  uploadFile: uploadFileMock,
  apiKeyRejected: apiKeyRejectedMock,
};

describe("ReadOnlyTracker", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.clearAllMocks();
  });

  it("passes reads through to the inner tracker", async () => {
    const tracker = new ReadOnlyTracker(inner);
    expect(tracker.kind).toBe("linear");
    expect(await tracker.resolveIssueId("API-42")).toEqual({ id: "issue-uuid-1", identifier: "API-42", teamKey: "API" });
    expect(await tracker.fetchTicket("issue-uuid-1")).toEqual(bundle);
    expect(await tracker.readDescription("issue-uuid-1")).toBe("Something is broken");
    expect(tracker.writes).toEqual([]);
  });

  it("records writes in order without calling the inner tracker", async () => {
    const tracker = new ReadOnlyTracker(inner);
    await tracker.writeDescription("issue-uuid-1", "new description");
    await tracker.postComment("issue-uuid-1", "a comment");
    expect(tracker.writes).toEqual([
      { method: "writeDescription", args: ["issue-uuid-1", "new description"] },
      { method: "postComment", args: ["issue-uuid-1", "a comment"] },
    ]);
    expect(writeDescriptionMock).not.toHaveBeenCalled();
    expect(postCommentMock).not.toHaveBeenCalled();
  });

  it("reports the inner tracker's API key state", () => {
    const tracker = new ReadOnlyTracker(inner);
    apiKeyRejectedMock.mockReturnValue(false);
    expect(tracker.apiKeyRejected()).toBe(false);
    apiKeyRejectedMock.mockReturnValue(true);
    expect(tracker.apiKeyRejected()).toBe(true);
  });

  it("returns a file:// url for uploads and records the call", async () => {
    const tracker = new ReadOnlyTracker(inner);
    expect(await tracker.uploadFile("/tmp/artifacts/shot.png", "image/png")).toEqual({ url: "file:///tmp/artifacts/shot.png" });
    expect(tracker.writes).toEqual([{ method: "uploadFile", args: ["/tmp/artifacts/shot.png", "image/png"] }]);
    expect(uploadFileMock).not.toHaveBeenCalled();
  });
});
