import { openStores, type Stores } from "../../src/store/index.js";
import { freshDataDir } from "./helpers.js";

let stores: Stores;

beforeEach(() => {
  vi.restoreAllMocks();
  stores = openStores(freshDataDir());
});

afterEach(() => {
  stores.db.close();
});

describe("DeliveryStore", () => {
  it("markSeen is true the first time and false on a repeat", () => {
    expect(stores.deliveries.markSeen("delivery-1")).toBe(true);
    expect(stores.deliveries.markSeen("delivery-1")).toBe(false);
    expect(stores.deliveries.markSeen("delivery-2")).toBe(true);
  });

  it("prune removes deliveries older than the cutoff and reports the count", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-01T00:00:00Z"));
    stores.deliveries.markSeen("old-1");
    stores.deliveries.markSeen("old-2");
    vi.setSystemTime(new Date("2026-09-11T00:00:00Z"));
    stores.deliveries.markSeen("recent");

    expect(stores.deliveries.prune(7)).toBe(2);

    expect(stores.deliveries.markSeen("old-1")).toBe(true);
    expect(stores.deliveries.markSeen("recent")).toBe(false);
    vi.useRealTimers();
  });
});
