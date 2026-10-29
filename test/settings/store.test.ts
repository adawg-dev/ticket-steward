import type { StewardConfig } from "../../src/config/schema.js";
import { DEFAULT_SETTINGS, seedSettings } from "../../src/settings/schema.js";
import { SettingsError, SettingsStore } from "../../src/settings/store.js";
import { openStores, type Stores } from "../../src/store/index.js";
import { freshDataDir } from "../store/helpers.js";

let stores: Stores;
let settings: SettingsStore;

const DEFAULTS = DEFAULT_SETTINGS;

beforeEach(() => {
  stores = openStores(freshDataDir());
  settings = new SettingsStore(stores.db, DEFAULTS);
});

afterEach(() => {
  stores.db.close();
});

describe("seedSettings", () => {
  it("holds the defaults, with the config's greptile.maxRounds over the bot-round cap", () => {
    expect(seedSettings({ greptile: undefined })).toEqual({
      "review.quietMinutes": 2,
      "greptile.maxRounds": 5,
      "greptile.passScore": 5,
      "greptile.enabled": true,
      "linear.reviewStateName": "In Review",
      "linear.moveToStarted": true,
      "linear.reviveByMention": true,
      "linear.activityIntervalMs": 2000,
      "ci.triage": true,
      "ci.retryLimit": 1,
      "ci.lookbackDays": 14,
    });
    const greptile = { maxRounds: 3 } as const satisfies Partial<NonNullable<StewardConfig["greptile"]>>;
    const config: Pick<StewardConfig, "greptile"> = {
      greptile: { botUsername: "greptile-bot", prompt: "fix.md", pollSeconds: 300, mrTimeoutMinutes: 30, reviewTimeoutMinutes: 30, pipelineTimeoutMinutes: 30, ciLogLines: 200, ...greptile },
    };
    expect(seedSettings(config)["greptile.maxRounds"]).toBe(3);
  });
});

describe("SettingsStore", () => {
  it("returns the seed while the DB holds nothing", () => {
    expect(settings.get()).toEqual(DEFAULTS);
    expect(settings.audit(10)).toEqual([]);
  });

  it("stores a change, reads it back on the next get, and audits old and new with who", () => {
    const after = settings.set({ "review.quietMinutes": 5 }, "x");
    expect(after["review.quietMinutes"]).toBe(5);
    expect(settings.get()).toEqual({ ...DEFAULTS, "review.quietMinutes": 5 });
    // Another store over the same DB (a later read, a restart) sees the row over its own seed.
    expect(new SettingsStore(stores.db, DEFAULTS).get()["review.quietMinutes"]).toBe(5);

    const audit = settings.audit(10);
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ key: "review.quietMinutes", oldValue: 2, newValue: 5, updatedBy: "x" });
    expect(typeof audit[0]?.updatedAt).toBe("string");
  });

  it("lists the newest change first and audits only what changed", () => {
    settings.set({ "review.quietMinutes": 5 }, "x");
    settings.set({ "review.quietMinutes": 5, "linear.reviewStateName": "Review" }, "y");
    expect(settings.audit(10).map(({ key, oldValue, newValue, updatedBy }) => ({ key, oldValue, newValue, updatedBy }))).toEqual([
      { key: "linear.reviewStateName", oldValue: "In Review", newValue: "Review", updatedBy: "y" },
      { key: "review.quietMinutes", oldValue: 2, newValue: 5, updatedBy: "x" },
    ]);
    expect(settings.audit(1)).toHaveLength(1);
  });

  it("refuses an invalid value and changes nothing", () => {
    expect(() => settings.set({ "review.quietMinutes": -1, "ci.triage": false }, "x")).toThrow(SettingsError);
    expect(settings.get()).toEqual(DEFAULTS);
    expect(settings.audit(10)).toEqual([]);
  });

  it("refuses an unknown key", () => {
    // Not a literal, so the compiler lets the extra key through the way a JSON body would.
    const patch = { "review.quietMinutes": 3, "worker.allowlist": ["*"] };
    expect(() => settings.set(patch, "x")).toThrow(/worker\.allowlist/);
    expect(settings.get()).toEqual(DEFAULTS);
  });

  it("reads the seed for a stored value the schema no longer accepts", () => {
    stores.db
      .prepare("INSERT INTO settings (key, value, updated_by, updated_at) VALUES (?, ?, ?, ?), (?, ?, ?, ?)")
      .run("review.quietMinutes", '"soon"', "x", "2026-10-29T00:00:00.000Z", "gone.key", "1", "x", "2026-10-29T00:00:00.000Z");
    expect(settings.get()).toEqual(DEFAULTS);
  });
});
