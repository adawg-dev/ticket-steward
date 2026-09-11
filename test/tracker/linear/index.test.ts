import { LinearTracker } from "../../../src/tracker/linear/client.js";
import { createLinearTracker } from "../../../src/tracker/linear/index.js";
import type { TokenPair, TokenStore } from "../../../src/store/tokens.js";

class MemoryTokenStore implements TokenStore {
  private pair: TokenPair | null = null;
  private broken = false;
  get(): TokenPair | null {
    return this.pair;
  }
  set(pair: TokenPair): void {
    this.pair = pair;
  }
  clear(): void {
    this.pair = null;
  }
  createOauthState(): string {
    return "state";
  }
  consumeOauthState(): boolean {
    return true;
  }
  setAuthBroken(v: boolean): void {
    this.broken = v;
  }
  isAuthBroken(): boolean {
    return this.broken;
  }
  withImmediateTransaction<T>(fn: () => T): T {
    return fn();
  }
}

describe("createLinearTracker", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("builds a LinearTracker from the token store and client credentials", () => {
    const tracker = createLinearTracker({ tokens: new MemoryTokenStore() }, { LINEAR_CLIENT_ID: "id", LINEAR_CLIENT_SECRET: "secret" });
    expect(tracker).toBeInstanceOf(LinearTracker);
    expect(tracker.kind).toBe("linear");
  });

  it("throws when the client credentials are missing", () => {
    expect(() => createLinearTracker({ tokens: new MemoryTokenStore() }, { LINEAR_CLIENT_ID: "id" })).toThrow();
  });
});
