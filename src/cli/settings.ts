import type { Command } from "commander";
import { z } from "zod";
import type { StewardConfig } from "../config/schema.js";
import { isSettingKey, seedSettings, SETTING_KEYS, SettingsPatchSchema, type SettingKey, type Settings, type SettingsPatch } from "../settings/schema.js";
import { SettingsError, SettingsStore } from "../settings/store.js";
import { openStores } from "../store/index.js";
import { AdminError, connectAdmin } from "./client.js";
import { errorMessage, fail, loadFromProgram, println, type CliContext } from "./context.js";

/** Who a change made straight in the DB (the local runtime, no admin API) is audited as. */
export const LOCAL_SETTINGS_BY = "cli";

/** Reads and changes the settings through the admin API when `serve` answers it (Kubernetes), else in the DB. */
interface SettingsAccess {
  get(): Promise<Settings>;
  set(patch: SettingsPatch): Promise<Settings>;
}

const access = async (ctx: CliContext, config: StewardConfig): Promise<SettingsAccess> => {
  const client = await connectAdmin(ctx, config).catch((err: unknown) => fail(ctx, errorMessage(err)));
  if (client !== null) return { get: () => client.settings(), set: (patch) => client.setSettings(patch) };
  const store = new SettingsStore(openStores(config.dataDir).db, seedSettings(config));
  return { get: () => Promise.resolve(store.get()), set: (patch) => Promise.resolve(store.set(patch, LOCAL_SETTINGS_BY)) };
};

const keyOf = (ctx: CliContext, key: string): SettingKey =>
  isSettingKey(key) ? key : fail(ctx, `unknown setting ${key}; known: ${SETTING_KEYS.join(", ")}`);

/** The value as JSON when it parses (`5`, `true`, `"x"`), else the text itself (`In Review`). */
export const parseSettingValue = (text: string): unknown => {
  try {
    const value: unknown = JSON.parse(text);
    return value;
  } catch {
    return text;
  }
};

export const registerSettings = (program: Command, ctx: CliContext): void => {
  const settings = program.command("settings").description("runtime settings: read on each use, changed without a restart, audited");

  settings
    .command("get")
    .description("print every setting (key and JSON value), or one setting's value")
    .argument("[key]", "a setting, e.g. review.quietMinutes")
    .action(async (key: string | undefined) => {
      const { config } = await loadFromProgram(program, ctx, { withoutSecrets: true });
      const wanted = key === undefined ? null : keyOf(ctx, key);
      const current = await (await access(ctx, config)).get();
      if (wanted !== null) return println(ctx, JSON.stringify(current[wanted]));
      for (const name of SETTING_KEYS) println(ctx, `${name}\t${JSON.stringify(current[name])}`);
    });

  settings
    .command("set")
    .description("change one setting; the value is parsed as JSON, else taken as a string")
    .argument("<key>", "a setting, e.g. review.quietMinutes")
    .argument("<value>", "e.g. 5, false or In Review")
    .action(async (key: string, value: string) => {
      const { config } = await loadFromProgram(program, ctx, { withoutSecrets: true });
      const name = keyOf(ctx, key);
      const patch = SettingsPatchSchema.safeParse({ [name]: parseSettingValue(value) });
      if (!patch.success) return fail(ctx, z.prettifyError(patch.error));
      try {
        const after = await (await access(ctx, config)).set(patch.data);
        println(ctx, `${name}\t${JSON.stringify(after[name])}`);
      } catch (err) {
        if (err instanceof SettingsError || err instanceof AdminError) return fail(ctx, err.message);
        throw err;
      }
    });
};
