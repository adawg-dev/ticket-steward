import { rm, writeFile } from "node:fs/promises";
import type { Command } from "commander";
import { join } from "node:path";
import type { loadConfig } from "../../src/config/load.js";
import { buildProgram } from "../../src/cli/program.js";
import { pushMcpSpec } from "../../src/push/target.js";
import { MODEL_SECRET_NAMES } from "../../src/keyproxy/server.js";
import { podSpecFor } from "../k8s/helpers.js";
import type { SecretName } from "../../src/config/load.js";
import { makeContext, tmpConfigDir } from "./helpers.js";

type LoadOptions = Parameters<typeof loadConfig>[0];

/** Runs a command with a loadConfig that records what it was asked for and stops there; null when it loaded none. */
const loadOf = async (args: string[]): Promise<LoadOptions | null> => {
  const test = makeContext();
  const calls: LoadOptions[] = [];
  test.ctx.loadConfig = async (opts) => {
    calls.push(opts);
    throw new Error("stop after loading");
  };
  await buildProgram(test.ctx).parseAsync(["node", "steward", "--config", "/etc/ticket-steward/steward.config.ts", ...args]).catch(() => undefined);
  return calls[0] ?? null;
};

const requested = async (args: string[]): Promise<LoadOptions> => {
  const call = await loadOf(args);
  if (call === null) throw new Error(`${args[0]} loaded no config`);
  return call;
};

/** Every registered command, as its words; a command with subcommands and its own action is listed itself too. */
const commandsOf = (command: Command, words: string[] = []): string[] => {
  const own = words.length > 0 && (command.commands.length === 0 || command.name() === "jobs") ? [words.join(" ")] : [];
  return [...own, ...command.commands.flatMap((sub) => commandsOf(sub, [...words, sub.name()]))];
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

describe("the secrets each CLI command loads", () => {
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

  /** Each command's arguments; serve and doctor alone read the Linear app's credentials. */
  const argsOf = (command: string): string[] => {
    const target = podSpecFor().push;
    const pushArgs = target === null ? [] : pushMcpSpec({ binPath: "/bin/steward", configPath: "/c", target }).args.slice(-2);
    const args: Record<string, string[]> = {
      "overlay sync": ["--from", dir],
      implement: ["API-1", "--dry-run"],
      chat: ["API-1"],
      "chat-hook": ["--workspace", dir, "--artifacts", dir],
      "jobs show": ["1"],
      "jobs retry": ["1"],
      "settings get": ["review.quietMinutes"],
      "settings set": ["review.quietMinutes", "3"],
      "mcp codehost": ["--workspace", dir, "--sha", "a".repeat(40)],
      "mcp push": pushArgs,
      "mcp orbit": ["--workspace", dir],
      tools: ["--spec", spec],
      "render-overlay": ["--agent-out", "/tmp/a", "--rules-out", "/tmp/r", "--guard-out", "/tmp/g"],
      "git-init": ["--spec", spec],
      "run-pod": ["--spec", spec],
    };
    return [...command.split(" "), ...(args[command] ?? [])];
  };

  const linearNames = (names: readonly SecretName[]): SecretName[] => names.filter((name) => name.startsWith("LINEAR_"));

  it("never the Linear app's credentials, except serve (which holds the token) and doctor (which checks them)", async () => {
    const commands = commandsOf(buildProgram(makeContext().ctx));
    expect(commands).toEqual(expect.arrayContaining(["serve", "doctor", "templates", "mcp push", "jobs", "chat-hook", "mirror fetch"]));
    for (const command of commands) {
      // These read no config: init writes one, and the session containers take MinIO from their flags (sync never ends).
      if (command === "init" || command.startsWith("sessions ")) continue;
      const load = await loadOf(argsOf(command));
      if (load === null || load.withoutSecrets === true) continue;
      if (command === "serve" || command === "doctor") {
        expect(load.secretNames, command).toBeUndefined();
        continue;
      }
      expect(load.secretNames, command).toBeDefined();
      expect(linearNames(load.secretNames ?? []), command).toEqual([]);
    }
  });

  it("mcp push: every secret but the Linear app's; codehost and orbit: the code host's tokens only", async () => {
    const push = await requested(argsOf("mcp push"));
    expect(push.secretNames).toContain("GITLAB_PUSH_TOKEN");
    expect(linearNames(push.secretNames ?? [])).toEqual([]);
    expect((await requested(argsOf("mcp codehost"))).secretNames).toEqual(["GITLAB_TOKEN", "GITHUB_TOKEN"]);
    expect((await requested(argsOf("mcp orbit"))).secretNames).toEqual(["GITLAB_TOKEN"]);
  });

  it("templates, jobs list and show, and chat-hook: no secret at all", async () => {
    for (const command of ["templates", "jobs", "jobs show", "chat-hook", "jobs gc", "overlay sync"]) {
      expect(await requested(argsOf(command)), command).toMatchObject({ withoutSecrets: true });
    }
  });
});
