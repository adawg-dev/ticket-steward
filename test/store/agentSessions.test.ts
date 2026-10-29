import { openStores, type Stores } from "../../src/store/index.js";
import { freshDataDir } from "./helpers.js";

let stores: Stores;

beforeEach(() => {
  vi.restoreAllMocks();
  stores = openStores(freshDataDir());
});

afterEach(() => {
  vi.useRealTimers();
  stores.db.close();
});

describe("AgentSessionStore", () => {
  it("records a ticket the steward was removed from until it is delegated again", () => {
    expect(stores.agentSessions.isUnassigned("issue-1")).toBe(false);
    stores.agentSessions.markUnassigned("issue-1");
    stores.agentSessions.markUnassigned("issue-1");
    expect(stores.agentSessions.isUnassigned("issue-1")).toBe(true);
    expect(stores.agentSessions.isUnassigned("issue-2")).toBe(false);
    stores.agentSessions.clearUnassigned("issue-1");
    expect(stores.agentSessions.isUnassigned("issue-1")).toBe(false);
  });

  it("knows no session for an issue it never recorded", () => {
    expect(stores.agentSessions.current("issue-1")).toBeNull();
    expect(stores.agentSessions.issueOf("session-1")).toBeNull();
  });

  it("maps every Linear session to its issue, the latest being current", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-29T10:00:00Z"));
    stores.agentSessions.record("session-1", "issue-1", "API-1");
    vi.setSystemTime(new Date("2026-10-29T11:00:00Z"));
    stores.agentSessions.record("session-2", "issue-1", "API-1");
    stores.agentSessions.record("session-9", "issue-9", "API-9");

    expect(stores.agentSessions.current("issue-1")).toBe("session-2");
    expect(stores.agentSessions.issueOf("session-1")).toBe("issue-1");
    expect(stores.agentSessions.issueOf("session-2")).toBe("issue-1");
    expect(stores.agentSessions.current("issue-9")).toBe("session-9");
  });

  it("keeps a session's first record when it is recorded again, so a prompt in an older session does not make it current", () => {
    stores.agentSessions.record("session-1", "issue-1", "API-1");
    stores.agentSessions.record("session-2", "issue-1", "API-1");
    stores.agentSessions.record("session-1", "issue-1", "API-1");

    expect(stores.agentSessions.current("issue-1")).toBe("session-2");
  });

  it("orders sessions recorded in the same millisecond by when they were recorded", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-29T10:00:00Z"));
    stores.agentSessions.record("session-b", "issue-1", "API-1");
    stores.agentSessions.record("session-a", "issue-1", "API-1");

    expect(stores.agentSessions.current("issue-1")).toBe("session-a");
  });
});
