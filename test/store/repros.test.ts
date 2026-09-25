import { openStores, type Stores } from "../../src/store/index.js";
import { freshDataDir } from "./helpers.js";

const recipe = { status: "reproduced" as const, method: "http" as const, command: "curl localhost:4100", steps: [], files: [], expected: "200", observed: "500" };

describe("ReproStore", () => {
  let stores: Stores;
  beforeEach(() => {
    stores = openStores(freshDataDir());
  });
  afterEach(() => stores.db.close());

  it("returns null for an unknown issue", () => {
    expect(stores.repros.get("issue-1")).toBeNull();
  });

  it("keeps the latest recipe per issue", () => {
    stores.repros.upsert({ issueId: "issue-1", identifier: "API-1", jobId: 1, sha: "a".repeat(40), recipe, filesDir: "/d/1" });
    stores.repros.upsert({ issueId: "issue-1", identifier: "API-1", jobId: 2, sha: "b".repeat(40), recipe: { ...recipe, observed: "502" }, filesDir: "/d/2" });
    const record = stores.repros.get("issue-1");
    expect(record).toMatchObject({ jobId: 2, sha: "b".repeat(40), filesDir: "/d/2", recipe: { observed: "502" } });
  });
});
