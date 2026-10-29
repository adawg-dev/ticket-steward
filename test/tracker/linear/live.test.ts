import { createLinearTracker } from "../../../src/tracker/linear/index.js";

const live = process.env.STEWARD_LIVE_LINEAR === "1";
const clientId = process.env.STEWARD_LIVE_LINEAR_CLIENT_ID ?? "";
const clientSecret = process.env.STEWARD_LIVE_LINEAR_CLIENT_SECRET ?? "";
const issueKey = process.env.STEWARD_LIVE_LINEAR_ISSUE ?? "";

describe.skipIf(!live)("LinearTracker (live)", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("resolves an issue key and fetches a ticket bundle", async () => {
    const tracker = createLinearTracker({ LINEAR_CLIENT_ID: clientId, LINEAR_CLIENT_SECRET: clientSecret });
    const resolved = await tracker.resolveIssueId(issueKey);
    expect(resolved.identifier).toBe(issueKey);
    const bundle = await tracker.fetchTicket(resolved.id);
    expect(bundle.id).toBe(resolved.id);
    expect(bundle.identifier).toBe(issueKey);
    expect(bundle.team.key).toBe(resolved.teamKey);
    expect(await tracker.readDescription(resolved.id)).toBe(bundle.description);
  });
});
