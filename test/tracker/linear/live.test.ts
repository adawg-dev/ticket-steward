import { LinearTracker } from "../../../src/tracker/linear/client.js";

const live = process.env.STEWARD_LIVE_LINEAR === "1";
const apiKey = process.env.STEWARD_LIVE_LINEAR_API_KEY ?? "";
const issueKey = process.env.STEWARD_LIVE_LINEAR_ISSUE ?? "";

describe.skipIf(!live)("LinearTracker (live)", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("resolves an issue key and fetches a ticket bundle", async () => {
    const tracker = new LinearTracker(apiKey);
    const resolved = await tracker.resolveIssueId(issueKey);
    expect(resolved.identifier).toBe(issueKey);
    const bundle = await tracker.fetchTicket(resolved.id);
    expect(bundle.id).toBe(resolved.id);
    expect(bundle.identifier).toBe(issueKey);
    expect(bundle.team.key).toBe(resolved.teamKey);
    expect(await tracker.readDescription(resolved.id)).toBe(bundle.description);
  });
});
