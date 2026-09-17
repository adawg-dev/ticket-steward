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
const thoughtMock = vi.fn<Tracker["agentSession"]["thought"]>();
const responseMock = vi.fn<Tracker["agentSession"]["response"]>();
const errorMock = vi.fn<Tracker["agentSession"]["error"]>();

const inner: Tracker = {
  kind: "linear",
  resolveIssueId: async () => ({ id: "issue-uuid-1", identifier: "API-42", teamKey: "API" }),
  fetchTicket: async () => bundle,
  readDescription: async () => "Something is broken",
  writeDescription: writeDescriptionMock,
  postComment: postCommentMock,
  uploadFile: uploadFileMock,
  agentSession: { thought: thoughtMock, response: responseMock, error: errorMock },
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
    await tracker.agentSession.thought("session-1", "thinking");
    await tracker.agentSession.response("session-1", "done");
    await tracker.agentSession.error("session-1", "oops");
    expect(tracker.writes).toEqual([
      { method: "writeDescription", args: ["issue-uuid-1", "new description"] },
      { method: "postComment", args: ["issue-uuid-1", "a comment"] },
      { method: "agentSession.thought", args: ["session-1", "thinking"] },
      { method: "agentSession.response", args: ["session-1", "done"] },
      { method: "agentSession.error", args: ["session-1", "oops"] },
    ]);
    expect(writeDescriptionMock).not.toHaveBeenCalled();
    expect(postCommentMock).not.toHaveBeenCalled();
    expect(thoughtMock).not.toHaveBeenCalled();
    expect(responseMock).not.toHaveBeenCalled();
    expect(errorMock).not.toHaveBeenCalled();
  });

  it("returns a file:// url for uploads and records the call", async () => {
    const tracker = new ReadOnlyTracker(inner);
    expect(await tracker.uploadFile("/tmp/artifacts/shot.png", "image/png")).toEqual({ url: "file:///tmp/artifacts/shot.png" });
    expect(tracker.writes).toEqual([{ method: "uploadFile", args: ["/tmp/artifacts/shot.png", "image/png"] }]);
    expect(uploadFileMock).not.toHaveBeenCalled();
  });
});
