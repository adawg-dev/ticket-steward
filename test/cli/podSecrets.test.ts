import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { loadConfig } from "../../src/config/load.js";
import { buildProgram } from "../../src/cli/program.js";
import { MODEL_SECRET_NAMES } from "../../src/keyproxy/server.js";
import { podSpecFor } from "../k8s/helpers.js";
import { makeContext, tmpConfigDir } from "./helpers.js";

type LoadOptions = Parameters<typeof loadConfig>[0];

/** Runs a run pod command with a loadConfig that records what it was asked for and stops there. */
const requested = async (args: string[]): Promise<LoadOptions> => {
  const test = makeContext();
  const calls: LoadOptions[] = [];
  test.ctx.loadConfig = async (opts) => {
    calls.push(opts);
    throw new Error("stop after loading");
  };
  await buildProgram(test.ctx).parseAsync(["node", "steward", "--config", "/etc/ticket-steward/steward.config.ts", ...args]).catch(() => undefined);
  const [call] = calls;
  if (call === undefined) throw new Error(`${args[0]} loaded no config; stderr: ${test.stderr()}`);
  return call;
};

describe("the secrets each run pod container loads", () => {
  let dir: string;
  let spec: string;

  beforeEach(async () => {
    dir = await tmpConfigDir();
    spec = join(dir, "spec.json");
    await writeFile(spec, JSON.stringify(podSpecFor()));
    vi.stubEnv("STEWARD_CALLBACK_URL", "http://steward-internal.invalid:3021");
    vi.stubEnv("STEWARD_TOOLS_TOKEN", "tools-token-value");
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await rm(dir, { recursive: true, force: true });
  });

  it("keyproxy: the model credential and its base URL only", async () => {
    expect((await requested(["keyproxy"])).secretNames).toEqual(MODEL_SECRET_NAMES);
  });

  it("git-init: the mirror's credential only", async () => {
    expect((await requested(["git-init", "--spec", spec])).secretNames).toEqual(["MIRROR_TOKEN", "MIRROR_USERNAME"]);
  });

  it("tools: the code host, push and mirror tokens only", async () => {
    expect((await requested(["tools", "--spec", spec])).secretNames).toEqual(["GITLAB_TOKEN", "GITLAB_PUSH_TOKEN", "GITHUB_TOKEN", "MIRROR_TOKEN", "MIRROR_USERNAME"]);
  });

  it("render-overlay: no steward secret, as it reads the template's ids itself", async () => {
    expect(await requested(["render-overlay", "--agent-out", "/tmp/a", "--rules-out", "/tmp/r", "--guard-out", "/tmp/g"])).toMatchObject({ withoutSecrets: true });
  });
});
