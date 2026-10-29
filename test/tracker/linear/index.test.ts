import { LinearTracker } from "../../../src/tracker/linear/client.js";
import { createLinearToken, createLinearTracker, requireLinearAppCredentials } from "../../../src/tracker/linear/index.js";

const MISSING = "LINEAR_CLIENT_ID and LINEAR_CLIENT_SECRET must be set (Secrets Manager DEV_STEWARD_LINEAR_CLIENT_ID and DEV_STEWARD_LINEAR_CLIENT_SECRET)";

describe("createLinearTracker", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("builds a LinearTracker from the app's client credentials without calling Linear", () => {
    const fetchImpl = vi.fn<typeof fetch>();
    const tracker = createLinearTracker({ LINEAR_CLIENT_ID: "id", LINEAR_CLIENT_SECRET: "secret" }, { fetchImpl });
    expect(tracker).toBeInstanceOf(LinearTracker);
    expect(tracker.kind).toBe("linear");
    expect(tracker.credentialsRejected()).toBe(false);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("throws naming both secrets when one is missing", () => {
    expect(() => createLinearTracker({ LINEAR_CLIENT_ID: "id", LINEAR_WEBHOOK_SECRET: "whsec" })).toThrow(MISSING);
  });
});

describe("createLinearToken", () => {
  it("mints with the app's scopes", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ access_token: "t", expires_in: 3600 }), { status: 200 }));
    expect(await createLinearToken({ LINEAR_CLIENT_ID: "id", LINEAR_CLIENT_SECRET: "secret" }, { fetchImpl }).get()).toBe("t");
    expect(fetchImpl.mock.calls[0]?.[1]?.body).toBe("grant_type=client_credentials&scope=read,write,app:assignable,app:mentionable");
  });
});

describe("requireLinearAppCredentials", () => {
  it("returns the client id and secret", () => {
    expect(requireLinearAppCredentials({ LINEAR_CLIENT_ID: "id", LINEAR_CLIENT_SECRET: "secret" })).toEqual({ clientId: "id", clientSecret: "secret" });
  });

  it("rejects an empty secret", () => {
    expect(() => requireLinearAppCredentials({ LINEAR_CLIENT_ID: "id", LINEAR_CLIENT_SECRET: "" })).toThrow(MISSING);
  });
});
