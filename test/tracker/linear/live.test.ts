import { LinearClient } from "@linear/sdk";
import { LinearAuth, type TokenRepository } from "../../../src/tracker/linear/auth.js";
import { LinearTracker } from "../../../src/tracker/linear/client.js";
import type { TokenPair } from "../../../src/store/tokens.js";

const live = process.env.STEWARD_LIVE_LINEAR === "1";
const accessToken = process.env.STEWARD_LIVE_LINEAR_TOKEN ?? "";
const issueKey = process.env.STEWARD_LIVE_LINEAR_ISSUE ?? "";

class StaticTokenRepository implements TokenRepository {
  private pair: TokenPair = { accessToken, refreshToken: "", expiresAt: new Date(Date.now() + 86_400_000).toISOString(), appUserId: null };
  get(): TokenPair | null {
    return this.pair;
  }
  set(p: TokenPair): void {
    this.pair = p;
  }
  setAuthBroken(): void {}
  withImmediateTransaction<T>(fn: () => T): T {
    return fn();
  }
}

describe.skipIf(!live)("LinearTracker (live)", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("resolves an issue key and fetches a ticket bundle", async () => {
    const auth = new LinearAuth(new StaticTokenRepository(), { clientId: "", clientSecret: "" });
    const tracker = new LinearTracker(auth, { clientFactory: (token) => new LinearClient({ accessToken: token }) });
    const resolved = await tracker.resolveIssueId(issueKey);
    expect(resolved.identifier).toBe(issueKey);
    const bundle = await tracker.fetchTicket(resolved.id);
    expect(bundle.id).toBe(resolved.id);
    expect(bundle.identifier).toBe(issueKey);
    expect(bundle.team.key).toBe(resolved.teamKey);
    expect(await tracker.readDescription(resolved.id)).toBe(bundle.description);
  });
});
