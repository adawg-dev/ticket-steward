import { z } from "zod";
import { reviewConfigOf, type StewardConfig } from "../config/schema.js";

/**
 * Behaviour that can change while the steward runs: stored in the dispatcher DB, seeded from the config file, read on each
 * use and changed through the admin API (`steward settings set`). Keys are flat and dotted. Credentials and anything
 * security-relevant (allowlists, guards) are never settings.
 */
const SettingFields = {
  /** Notes on the MR are batched over this quiet window into one round. */
  "review.quietMinutes": z.number().nonnegative(),
  /** Rounds started only by bot notes or a red pipeline stop here; seeded from the config's `greptile.maxRounds`. */
  "greptile.maxRounds": z.number().int().positive(),
  /** At this Greptile confidence on the head commit, bot-started rounds end. */
  "greptile.passScore": z.number().int().min(1).max(5),
  /** Off: a configured Greptile is neither asked for reviews nor waited for. */
  "greptile.enabled": z.boolean(),
  /** The Linear workflow state a ticket moves to once its MR is open. */
  "linear.reviewStateName": z.string().min(1),
  /** Move the ticket to the team's started state when a job starts. */
  "linear.moveToStarted": z.boolean(),
  /** A mention of the steward on an unassigned ticket with a parked loop revives it. */
  "linear.reviveByMention": z.boolean(),
  /** The least time between two activities in Linear's agent panel. */
  "linear.activityIntervalMs": z.number().int().nonnegative(),
  /** Retry infrastructure and flaky CI failures before they count as a round. */
  "ci.triage": z.boolean(),
  /** Retries of one flaky job per commit. */
  "ci.retryLimit": z.number().int().nonnegative(),
  /** How far back the default branch's failures count as a flaky signal. */
  "ci.lookbackDays": z.number().int().positive(),
};

/** Every setting, each required: what is in effect. Unknown keys are refused. */
export const SettingsSchema = z.strictObject(SettingFields);

/**
 * A change: known keys only, each valid on its own. Defaults live in `DEFAULT_SETTINGS`, not in the schema, because a
 * zod default inside `.partial()` would fill every key a patch leaves out.
 */
export const SettingsPatchSchema = SettingsSchema.partial();

export type Settings = z.output<typeof SettingsSchema>;
export type SettingKey = keyof Settings;
/** Some settings; a key may also hold `undefined`, read as "not in the patch". */
export type SettingsPatch = z.output<typeof SettingsPatchSchema>;

export const DEFAULT_SETTINGS: Settings = {
  "review.quietMinutes": 2,
  "greptile.maxRounds": 5,
  "greptile.passScore": 5,
  "greptile.enabled": true,
  "linear.reviewStateName": "In Review",
  "linear.moveToStarted": true,
  "linear.reviveByMention": true,
  "linear.activityIntervalMs": 2_000,
  "ci.triage": true,
  "ci.retryLimit": 1,
  "ci.lookbackDays": 14,
};

export const SETTING_KEYS: readonly SettingKey[] = SettingsSchema.keyof().options;

export const isSettingKey = (key: string): key is SettingKey => SETTING_KEYS.some((known) => known === key);

/** The defaults with what the config file says over them. */
export const seedSettings = (config: Pick<StewardConfig, "greptile" | "reviewLoop">): Settings => {
  const greptile = config.greptile;
  const review = reviewConfigOf(config);
  return SettingsSchema.parse({
    ...DEFAULT_SETTINGS,
    ...(review === null ? {} : { "greptile.maxRounds": review.maxRounds }),
    ...(greptile?.passScore === undefined ? {} : { "greptile.passScore": greptile.passScore }),
  });
};

/** The settings a loop step acts on: with no `greptile` configured, Greptile is off whatever the setting says. */
export const loopSettings = (config: Pick<StewardConfig, "greptile">, settings: Settings): Settings =>
  config.greptile === undefined ? { ...settings, "greptile.enabled": false } : settings;
