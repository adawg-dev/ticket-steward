import { ReadOnlyTracker } from "../../src/tracker/readOnly.js";
import { FAKE_APP_USER_ID, FakeTracker } from "../fakes/fakeTracker.js";
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

const credentialsRejectedMock = vi.fn<Tracker["credentialsRejected"]>();

const inner: Tracker = {
  kind: "linear",
  resolveIssueId: async () => ({ id: "issue-uuid-1", identifier: "API-42", teamKey: "API" }),
  fetchTicket: async () => bundle,
  readDescription: async () => "Something is broken",
  appUserId: async () => "app-user-1",
  credentialsRejected: credentialsRejectedMock,
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
  });

  it("reads the app user from the inner tracker", async () => {
    expect(await new ReadOnlyTracker(new FakeTracker([bundle])).appUserId()).toBe(FAKE_APP_USER_ID);
  });

  it("reports the inner tracker's credential state", () => {
    const tracker = new ReadOnlyTracker(inner);
    credentialsRejectedMock.mockReturnValue(false);
    expect(tracker.credentialsRejected()).toBe(false);
    credentialsRejectedMock.mockReturnValue(true);
    expect(tracker.credentialsRejected()).toBe(true);
  });
});
