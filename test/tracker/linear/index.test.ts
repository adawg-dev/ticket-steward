import { LinearTracker } from "../../../src/tracker/linear/client.js";
import { createLinearTracker } from "../../../src/tracker/linear/index.js";
import type { TokenPair } from "../../../src/store/tokens.js";
import type { TokenRepository } from "../../../src/tracker/linear/auth.js";

class MemoryTokenStore implements TokenRepository {
  private pair: TokenPair | null = null;
  private broken = false;
  get(): TokenPair | null {
    return this.pair;
  }
  set(pair: TokenPair): void {
    this.pair = pair;
  }
  setAuthBroken(v: boolean): void {
    this.broken = v;
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
