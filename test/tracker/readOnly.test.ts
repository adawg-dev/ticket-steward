import { ReadOnlyTracker } from "../../src/tracker/readOnly.js";
import { FakeTracker } from "../fakes/fakeTracker.js";
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

const swapLabelMock = vi.fn<Tracker["swapLabel"]>();
const apiKeyRejectedMock = vi.fn<Tracker["apiKeyRejected"]>();

const inner: Tracker = {
  kind: "linear",
  resolveIssueId: async () => ({ id: "issue-uuid-1", identifier: "API-42", teamKey: "API" }),
  fetchTicket: async () => bundle,
  readDescription: async () => "Something is broken",
  swapLabel: swapLabelMock,
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
    await tracker.swapLabel("issue-uuid-1", "ready-for-agent", "agent-implemented");
    await tracker.swapLabel("issue-uuid-1", "agent-implemented", "agent-approved");
    expect(tracker.writes).toEqual([
      { method: "swapLabel", args: ["issue-uuid-1", "ready-for-agent", "agent-implemented"] },
      { method: "swapLabel", args: ["issue-uuid-1", "agent-implemented", "agent-approved"] },
    ]);
    expect(swapLabelMock).not.toHaveBeenCalled();
  });

  it("reports the inner tracker's API key state", () => {
    const tracker = new ReadOnlyTracker(inner);
    apiKeyRejectedMock.mockReturnValue(false);
    expect(tracker.apiKeyRejected()).toBe(false);
    apiKeyRejectedMock.mockReturnValue(true);
    expect(tracker.apiKeyRejected()).toBe(true);
  });

  it("records swapLabel without forwarding it", async () => {
    const fake = new FakeTracker([bundle]);
    const tracker = new ReadOnlyTracker(fake);
    await tracker.swapLabel("issue-uuid-1", "needs-triage", "needs-info");
    expect(tracker.writes).toEqual([{ method: "swapLabel", args: ["issue-uuid-1", "needs-triage", "needs-info"] }]);
    expect(fake.labelSwaps()).toEqual([]);
  });
});
