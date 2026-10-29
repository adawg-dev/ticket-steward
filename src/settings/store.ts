import { z } from "zod";
import { logger } from "../log.js";
import { nowIso, type Database } from "../store/db.js";
import { transaction } from "../store/index.js";
import { isSettingKey, SettingsPatchSchema, SettingsSchema, type Settings, type SettingsPatch } from "./schema.js";

/** A patch the schema refuses: an unknown key or an invalid value. `message` names each. */
export class SettingsError extends Error {}

/** One audited change of one setting; `oldValue` is what was in effect before (the seed when nothing was stored). */
export interface SettingsChange {
  id: number;
  key: string;
  oldValue: unknown;
  newValue: unknown;
  updatedBy: string;
  updatedAt: string;
}

const SettingRows = z.array(z.object({ key: z.string(), value: z.string() }));
const AuditRows = z.array(
  z.object({ id: z.number(), key: z.string(), old_value: z.string().nullable(), new_value: z.string(), updated_by: z.string(), updated_at: z.string() }),
);

const parseJson = (raw: string): unknown => {
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
};

/**
 * The runtime settings: rows in `settings` over the seed (defaults plus the config file), read on every `get`, so a change
 * takes effect at the next use without a restart. Every change is written with an audit row in one transaction.
 */
export class SettingsStore {
  constructor(
    private readonly db: Database,
    private readonly seed: Settings,
  ) {}

  /** The seed with every stored value over it; a stored value the schema no longer accepts is ignored (and logged). */
  get(): Settings {
    const merged: Record<string, unknown> = { ...this.seed };
    for (const row of SettingRows.parse(this.db.prepare("SELECT key, value FROM settings").all())) {
      if (!isSettingKey(row.key)) continue;
      const parsed = SettingsSchema.shape[row.key].safeParse(parseJson(row.value));
      if (parsed.success) merged[row.key] = parsed.data;
      else logger.warn({ key: row.key }, "settings: a stored value is no longer valid; using the seed");
    }
    return SettingsSchema.parse(merged);
  }

  /** Applies `patch` as `by` and returns the settings now in effect; throws `SettingsError`, changing nothing, when it is invalid. */
  set(patch: SettingsPatch, by: string): Settings {
    const parsed = SettingsPatchSchema.safeParse(patch);
    if (!parsed.success) throw new SettingsError(z.prettifyError(parsed.error));
    const changes = Object.fromEntries(Object.entries(parsed.data).filter(([, value]) => value !== undefined));
    return transaction(this.db, () => {
      const before = this.get();
      const merged = SettingsSchema.safeParse({ ...before, ...changes });
      if (!merged.success) throw new SettingsError(z.prettifyError(merged.error));
      const at = nowIso();
      const upsert = this.db.prepare<[string, string, string, string]>(
        "INSERT INTO settings (key, value, updated_by, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_by = excluded.updated_by, updated_at = excluded.updated_at",
      );
      const audit = this.db.prepare<[string, string, string, string, string]>(
        "INSERT INTO settings_audit (key, old_value, new_value, updated_by, updated_at) VALUES (?, ?, ?, ?, ?)",
      );
      for (const key of Object.keys(changes)) {
        if (!isSettingKey(key)) continue;
        const oldValue = JSON.stringify(before[key]);
        const newValue = JSON.stringify(merged.data[key]);
        if (oldValue === newValue) continue;
        upsert.run(key, newValue, by, at);
        audit.run(key, oldValue, newValue, by, at);
        logger.info({ key, by }, "settings: changed");
      }
      return merged.data;
    });
  }

  /** The latest `limit` changes, newest first. */
  audit(limit: number): SettingsChange[] {
    const rows = AuditRows.parse(
      this.db.prepare("SELECT id, key, old_value, new_value, updated_by, updated_at FROM settings_audit ORDER BY id DESC LIMIT ?").all(limit),
    );
    return rows.map((row) => ({
      id: row.id,
      key: row.key,
      oldValue: row.old_value === null ? null : parseJson(row.old_value),
      newValue: parseJson(row.new_value),
      updatedBy: row.updated_by,
      updatedAt: row.updated_at,
    }));
  }
}
