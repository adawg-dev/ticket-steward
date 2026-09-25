import { LinearTracker } from "../../../src/tracker/linear/client.js";
import { createLinearTracker, requireLinearApiKey } from "../../../src/tracker/linear/index.js";

describe("createLinearTracker", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("builds a LinearTracker from LINEAR_API_KEY", () => {
    const tracker = createLinearTracker({ LINEAR_API_KEY: "lin_api_test" });
    expect(tracker).toBeInstanceOf(LinearTracker);
    expect(tracker.kind).toBe("linear");
    expect(tracker.apiKeyRejected()).toBe(false);
  });

  it("throws when LINEAR_API_KEY is missing", () => {
    expect(() => createLinearTracker({ LINEAR_WEBHOOK_SECRET: "whsec" })).toThrow("LINEAR_API_KEY must be set in .env");
  });
});

describe("requireLinearApiKey", () => {
  it("returns the key", () => {
    expect(requireLinearApiKey({ LINEAR_API_KEY: "lin_api_test" })).toBe("lin_api_test");
  });

  it("rejects an empty key", () => {
    expect(() => requireLinearApiKey({ LINEAR_API_KEY: "" })).toThrow("LINEAR_API_KEY must be set in .env");
  });
});
