import { statSync } from "node:fs";
import { join } from "node:path";
import { openStores, transaction } from "../../src/store/index.js";
import { createdEvent, freshDataDir } from "./helpers.js";

beforeEach(() => {
  vi.restoreAllMocks();
});

describe("openStores", () => {
  it("two stores on the same data dir see each other's writes", () => {
    const dataDir = freshDataDir();
    const a = openStores(dataDir);
    const b = openStores(dataDir);

    const id = a.jobs.enqueue(createdEvent);
    b.tokens.setAuthBroken(true);

    expect(b.jobs.get(id)?.issueId).toBe("issue-1");
    expect(a.tokens.isAuthBroken()).toBe(true);
    a.db.close();
    b.db.close();
  });

  it("creates a 0700 data dir and a 0600 database file", () => {
    const dataDir = join(freshDataDir(), "nested", "data");

    const stores = openStores(dataDir);

    expect(statSync(dataDir).mode & 0o777).toBe(0o700);
    expect(statSync(join(dataDir, "steward.db")).mode & 0o777).toBe(0o600);
    stores.db.close();
  });

  it("transaction rolls back every write when the callback throws", () => {
    const stores = openStores(freshDataDir());

    expect(() =>
      transaction(stores.db, () => {
        stores.deliveries.markSeen("delivery-1");
        stores.jobs.enqueue(createdEvent);
        throw new Error("abort");
      }),
    ).toThrow();

    expect(stores.deliveries.markSeen("delivery-1")).toBe(true);
    expect(stores.jobs.list({ limit: 10 })).toEqual([]);
    stores.db.close();
  });
});
