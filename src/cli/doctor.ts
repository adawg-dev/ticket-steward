import { existsSync } from "node:fs";
import { mkdir, readdir, rm, stat } from "node:fs/promises";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { Command } from "commander";
import { z } from "zod";
import { listProtectedBranches, protectionProblems } from "../codehost/gitlabProtection.js";
import { createGitLabMr } from "../codehost/gitlabMr.js";
import { codehostMcpSpec } from "../codehost/server.js";
import type { LoadedConfig } from "../config/load.js";
import { appPortOf, kubernetesRuntime, type SlotsConfig, type StewardConfig } from "../config/schema.js";
import { execOrbit, orbitEnv } from "../orbit/run.js";
import { orbitRemote, runOrbitTool } from "../orbit/server.js";
import { createLinearToken, type LinearToken } from "../tracker/linear/index.js";
import { listFiles } from "../workspace/files.js";
import { git, scrubCredentials } from "../workspace/git.js";
import { injectToken, splitCredentials } from "../workspace/mirror.js";
import { missingOverrideKeys } from "../workspace/overlay.js";
import { isPortFree } from "../workspace/retention.js";
import { SlotClient } from "../workspace/slots.js";
import { flunk, ok, warn, type Check, type CheckResult } from "./check.js";
import { errorMessage, exitWith, loadFromProgram, println, type CliContext } from "./context.js";
import { kubernetesChecks, kubernetesDoctorDeps } from "./doctorKubernetes.js";
import { binPath } from "./paths.js";
import { withTimeout } from "./probe.js";
import { openMirror } from "./runtime.js";

const HEALTH_TIMEOUT_MS = 3_000;
const MCP_TIMEOUT_MS = 10_000;
const LINEAR_GRAPHQL_URL = "https://api.linear.app/graphql";
const playwrightBrowsersPath = (): string => process.env.PLAYWRIGHT_BROWSERS_PATH ?? join(homedir(), ".cache", "ms-playwright");
const SENSITIVE_HOME_DIRS = [".ssh", ".kube"];

const ViewerResponse = z.object({ data: z.object({ viewer: z.object({ id: z.string(), name: z.string() }) }) });
const GraphqlErrors = z.object({ errors: z.array(z.object({ extensions: z.object({ code: z.string().optional() }).optional() })) });

const missing = (secrets: Record<string, string | undefined>, keys: string[]): string[] => keys.filter((key) => secrets[key] === undefined || secrets[key] === "");

const modeCheck = (label: string, path: string): Check => ({
  name: `${label} mode`,
  run: async () => {
    if (!existsSync(path)) return flunk(`${path} does not exist`);
    const mode = (await stat(path)).mode & 0o777;
    return mode === 0o700 ? ok(`${path} is 0700`) : flunk(`${path} is ${mode.toString(8)}, expected 0700`);
  },
});

const userCheck: Check = {
  name: "running user",
  run: async () => {
    const uid = process.getuid?.() ?? -1;
    const owned: string[] = [];
    for (const dir of SENSITIVE_HOME_DIRS) {
      const path = join(homedir(), dir);
      if (existsSync(path) && (await stat(path)).uid === uid) owned.push(path);
    }
    return owned.length === 0 ? ok("owns no ~/.ssh or ~/.kube") : warn(`owns ${owned.join(", ")}; run the steward as a dedicated user`);
  },
};

const secretChecks = ({ config, secrets }: LoadedConfig): Check[] => {
  const brainKeys = config.brain.kind === "claude-code" ? ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN"] : ["OPENAI_API_KEY"];
  const codehostKey = config.codehost.kind === "gitlab" ? "GITLAB_TOKEN" : "GITHUB_TOKEN";
  return [
    {
      name: "webhook secret",
      run: async () => (missing(secrets, ["LINEAR_WEBHOOK_SECRET"]).length === 0 ? ok("LINEAR_WEBHOOK_SECRET present") : flunk("missing LINEAR_WEBHOOK_SECRET")),
    },
    {
      name: "brain credential",
      run: async () =>
        missing(secrets, brainKeys).length < brainKeys.length ? ok(`${config.brain.kind} credential present`) : flunk(`set one of ${brainKeys.join(", ")}`),
    },
    {
      name: "codehost token",
      run: async () => (missing(secrets, [codehostKey]).length === 0 ? ok(`${codehostKey} present`) : flunk(`missing ${codehostKey}`)),
    },
    {
      name: "mirror token",
      run: async () => (missing(secrets, ["MIRROR_TOKEN"]).length === 0 ? ok("MIRROR_TOKEN present") : warn("MIRROR_TOKEN missing; fetchUrl must be reachable anonymously")),
    },
  ];
};

const overlayCheck = (config: StewardConfig): Check => ({
  name: "overlay",
  run: async () => {
    if (!existsSync(config.workspace.overlayDir)) return flunk(`${config.workspace.overlayDir} missing; run steward overlay sync`);
    const files = await listFiles(config.workspace.overlayDir);
    return files.length > 0 ? ok(`${files.length} file(s)`) : flunk("overlay is empty; run steward overlay sync");
  },
});

/** On the Kubernetes runtime each run renders its overlay from the template (doctor's "overlay template" check), so overlayDir is unused. */
const workspaceChecks = (loaded: LoadedConfig): Check[] => {
  const { config } = loaded;
  const onKubernetes = kubernetesRuntime(config) !== null;
  return [
    modeCheck("dataDir", config.dataDir),
    ...(onKubernetes ? [] : [modeCheck("overlayDir", config.workspace.overlayDir)]),
    {
      name: "mirror",
      run: async () => {
        const mirror = openMirror(loaded);
        if (!mirror.exists()) return flunk(`${mirror.path} missing; run steward mirror init`);
        if (!(await mirror.hasWorktreeConfigExtension())) return flunk(`${mirror.path} lacks extensions.worktreeConfig`);
        await mirror.fetch();
        return ok(`${mirror.path} fetched; ${config.workspace.baseBranch}@${(await mirror.resolveSha(config.workspace.baseBranch)).slice(0, 7)}`);
      },
    },
    ...(onKubernetes ? [] : [overlayCheck(config)]),
    {
      name: "skills",
      run: async () => {
        const { skillsDir } = config.workspace;
        if (skillsDir === undefined) return ok("not configured");
        return existsSync(skillsDir) ? ok(skillsDir) : flunk(`${skillsDir} does not exist`);
      },
    },
  ];
};

/** Linear answers a bad key with 401 or with a GraphQL AUTHENTICATION_ERROR. */
const isAuthenticationError = (status: number, body: unknown): boolean =>
  status === 401 || (GraphqlErrors.safeParse(body).data?.errors.some((error) => error.extensions?.code === "AUTHENTICATION_ERROR") ?? false);

/**
 * Mints a token for the steward's Linear app, reads `viewer`, and revokes the token again: doctor holds it for one
 * query only.
 */
const linearChecks = ({ secrets }: LoadedConfig, ctx: CliContext): Check[] => [
  {
    name: "linear app",
    run: async () => {
      const fetchImpl: typeof fetch = (input, init) => ctx.fetchImpl(input, { ...init, signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS) });
      let token: LinearToken;
      try {
        token = createLinearToken(secrets, { fetchImpl });
      } catch (err) {
        return flunk(errorMessage(err));
      }
      try {
        const response = await fetchImpl(LINEAR_GRAPHQL_URL, {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${await token.get()}` },
          body: JSON.stringify({ query: "{ viewer { id name } }" }),
        });
        const body: unknown = await response.json().catch(() => undefined);
        if (isAuthenticationError(response.status, body)) return flunk("Linear rejected the app's freshly minted token");
        if (!response.ok) return flunk(`viewer query answered ${response.status}`);
        const { id, name } = ViewerResponse.parse(body).data.viewer;
        return ok(`authenticated as ${name} (app user ${id})`);
      } finally {
        await token.revoke().catch(() => undefined);
      }
    },
  },
];

/** A fresh empty steward-owned dir for token-carrying ls-remote; the ceiling keeps git from discovering any repo config above it. */
const lsRemoteSite = async (dataDir: string): Promise<{ cwd: string; ceiling: string }> => {
  const ceiling = join(dataDir, "doctor");
  const cwd = join(ceiling, "ls-remote");
  await rm(cwd, { recursive: true, force: true });
  await mkdir(cwd, { recursive: true, mode: 0o700 });
  return { cwd, ceiling };
};

const implementChecks = (loaded: LoadedConfig, ctx: CliContext): Check[] => {
  const { config, secrets } = loaded;
  const checks: Check[] = [];
  const settings = config.implement;
  if (settings === undefined) return checks;
  checks.push({
    name: "push token",
    run: async () => {
      const token = secrets.GITLAB_PUSH_TOKEN ?? "";
      if (token === "") return flunk("GITLAB_PUSH_TOKEN is missing");
      const remote = splitCredentials(injectToken(config.workspace.fetchUrl, token));
      const site = await lsRemoteSite(config.dataDir);
      const result = await git(["ls-remote", "--heads", remote.url, config.workspace.baseBranch], site.cwd, { ...remote.env, GIT_CEILING_DIRECTORIES: site.ceiling });
      return result.exitCode === 0 ? ok(`GITLAB_PUSH_TOKEN reaches ${remote.url}`) : flunk(`ls-remote failed: ${scrubCredentials(result.stderr)}`);
    },
  });
  if (config.codehost.kind === "gitlab") {
    const { baseUrl, project } = config.codehost;
    checks.push({
      name: "branch protection",
      run: async () => {
        const token = secrets.GITLAB_TOKEN ?? "";
        if (token === "") return warn("GITLAB_TOKEN is missing; cannot read branch protection");
        const problems = protectionProblems(await listProtectedBranches({ baseUrl, project, token, fetchImpl: ctx.fetchImpl }), settings.protectedBranches);
        return problems.length === 0 ? ok(`${settings.protectedBranches.join(", ")} closed to Developer-role bots`) : flunk(problems.join("; "));
      },
    });
  }
  return checks;
};

/** Either verifies GitLab's webhook deliveries; the signing token is preferred. */
const GITLAB_WEBHOOK_KEYS = ["GITLAB_WEBHOOK_SIGNING_TOKEN", "GITLAB_WEBHOOK_SECRET"];

const pollingEvery = (seconds: number): string => (seconds % 60 === 0 ? `${seconds / 60}-minute polling` : `polling every ${seconds} seconds`);

/** Only with `greptile`: the GitLab token can write notes and resolve threads, the bot user exists, the fix prompt is there, and webhooks can be verified. */
const greptileChecks = ({ config, secrets }: LoadedConfig, ctx: CliContext): Check[] => {
  const settings = config.greptile;
  if (settings === undefined) return [];
  const gitlab = ctx.factories?.gitlab ?? createGitLabMr(config, secrets);
  const unavailable = (): CheckResult => warn("GITLAB_TOKEN is missing; cannot reach GitLab");
  return [
    {
      name: "gitlab token scope",
      run: async () => {
        if (gitlab === undefined) return unavailable();
        const scopes = await gitlab.tokenScopes();
        return scopes.includes("api") ? ok("GITLAB_TOKEN has the api scope") : flunk(`gitlab token lacks api scope (has ${scopes.join(", ") || "none"}); the loop replies to and resolves threads`);
      },
    },
    {
      name: "greptile bot",
      run: async () => {
        if (gitlab === undefined) return unavailable();
        return (await gitlab.userExists(settings.botUsername))
          ? ok(`${settings.botUsername} exists`)
          : flunk(`greptile bot user ${settings.botUsername} not found; check greptile.botUsername`);
      },
    },
    {
      name: "greptile prompt",
      run: async () => (existsSync(settings.prompt) ? ok(settings.prompt) : flunk(`${settings.prompt} does not exist; copy prompts/fix.md there`)),
    },
    {
      name: "gitlab webhook secret",
      run: async () => {
        const present = GITLAB_WEBHOOK_KEYS.filter((key) => missing(secrets, [key]).length === 0);
        return present.length > 0
          ? ok(`${present.join(", ")} present`)
          : warn(`neither ${GITLAB_WEBHOOK_KEYS.join(" nor ")} is set; the loop falls back to ${pollingEvery(settings.pollSeconds)}`);
      },
    },
  ];
};

/** Where the install puts the helper; ops/steward-slot@.service runs it from here. */
export const SLOT_HELPER_PATH = "/usr/local/sbin/steward-slot";
/** ops/steward-slot.socket; any other slots.socket means the helper runs in the Compose stack's slot-helper container. */
export const SLOT_SYSTEMD_SOCKET = "/run/steward-slot.sock";
const SLOTS_DOC = 'docs/ops.md, "Worker slots"';
const COMPOSE_DOC = 'docs/ops.md, "Running with Docker Compose"';

/** Where the helper runs: installed on this host behind systemd, or in the slot-helper container. */
type SlotHelperHost = { kind: "systemd"; helper: string } | { kind: "container"; systemdSocket: string };

/** The command an operator runs to take slot n down by hand. */
const slotDownCommand = (host: SlotHelperHost, n: number): string =>
  host.kind === "systemd" ? `${host.helper} down ${n} as root` : `docker compose exec slot-helper steward-slot down ${n}`;

/**
 * On the host the helper runs as root: nobody but root may be able to change it. Doctor can read it (it is world-readable).
 * In a container the helper file is not on this filesystem; the image is its owner, so only the socket is checked.
 */
const slotHelperCheck = (host: SlotHelperHost, socketPath: string): Check => ({
  name: "slot helper",
  run: async () => {
    if (host.kind === "container") {
      return ok(`slots.socket is ${socketPath}, not ${host.systemdSocket}: the helper runs in the slot-helper container; host ownership check skipped`);
    }
    const { helper } = host;
    if (!existsSync(helper)) return flunk(`${helper} does not exist; install ops/steward-slot (${SLOTS_DOC})`);
    const info = await stat(helper);
    if (info.uid !== 0) return flunk(`${helper} is not owned by root; chown root:root ${helper}`);
    if ((info.mode & 0o022) !== 0) return flunk(`${helper} is writable by group or others; chmod 0755 ${helper}`);
    return ok(`${helper} is root-owned and not group- or world-writable`);
  },
});

/** The socket exists and the helper behind it answers `check` (compose file parses, images pulled). */
const slotSocketCheck = (host: SlotHelperHost, socketPath: string, client: SlotClient): Check => ({
  name: "slot socket",
  run: async () => {
    if (!existsSync(socketPath)) {
      const remedy = host.kind === "systemd" ? `systemctl enable --now steward-slot.socket (${SLOTS_DOC})` : `is the slot-helper service up? (${COMPOSE_DOC})`;
      return flunk(`${socketPath} does not exist; ${remedy}`);
    }
    if (!(await stat(socketPath)).isSocket()) return flunk(`${socketPath} is not a socket`);
    const result = await client.check();
    return result.ok ? ok(`${socketPath}: check ok`) : flunk(`check over ${socketPath} failed: ${result.output}; see ${SLOTS_DOC}`);
  },
});

/** Doctor expects every slot down (serve stopped or idle), so a held service port usually means a slot left up. */
const slotPortsCheck = (config: StewardConfig, host: SlotHelperHost, client: SlotClient, n: number): Check => ({
  name: `slot ${n} ports`,
  run: async () => {
    const ports = await client.ports(n);
    const named: Array<[string, number]> = [["app", appPortOf(config, n)], ["postgres", ports.postgres], ["redis", ports.redis], ["rabbitmq", ports.rabbitmq]];
    const busy: string[] = [];
    for (const [name, port] of named) if (!(await isPortFree(port))) busy.push(`${name} ${port}`);
    if (busy.length === 0) return ok(`${named.map(([name, port]) => `${name} ${port}`).join(", ")} free`);
    if ((await client.status(n)) !== "") return flunk(`slot ${n} is up (${busy.join(", ")} in use); stop serve or run ${slotDownCommand(host, n)}`);
    return flunk(`in use: ${busy.join(", ")}`);
  },
});

const slotEnvCheck = (config: StewardConfig, slots: SlotsConfig): Check => ({
  name: "slot env keys",
  run: async () => {
    const keys = Object.keys(slots.env);
    const absent = await missingOverrideKeys(config.workspace.overlayDir, keys);
    return absent.length === 0 ? ok(`${keys.length} key(s) found in the overlay`) : flunk(`not in any overlay file: ${absent.join(", ")}; remove them from slots.env or sync the overlay`);
  },
});

/** Without `slots`: workspace.port is free. With `slots`: the helper, its socket, every slot's ports and the env keys. */
const portChecks = ({ config }: LoadedConfig, ctx: CliContext): Check[] => {
  const slots = config.slots;
  if (slots === undefined) {
    return [
      {
        name: "port",
        run: async () => {
          const port = appPortOf(config, 1);
          return (await isPortFree(port)) ? ok(`${port} is free`) : flunk(`${port} is in use`);
        },
      },
    ];
  }
  const client = new SlotClient(slots, ctx.factories?.slotRunner);
  const systemdSocket = ctx.factories?.slotSystemdSocket ?? SLOT_SYSTEMD_SOCKET;
  const host: SlotHelperHost =
    slots.socket === systemdSocket ? { kind: "systemd", helper: ctx.factories?.slotHelperPath ?? SLOT_HELPER_PATH } : { kind: "container", systemdSocket };
  return [
    slotHelperCheck(host, slots.socket),
    slotSocketCheck(host, slots.socket, client),
    ...Array.from({ length: slots.count }, (_, index) => slotPortsCheck(config, host, client, index + 1)),
    slotEnvCheck(config, slots),
  ];
};

const chromiumCheck: Check = {
  name: "chromium",
  run: async () => {
    const browsers = playwrightBrowsersPath();
    const entries = existsSync(browsers) ? await readdir(browsers) : [];
    const chromium = entries.filter((entry) => entry.startsWith("chromium"));
    return chromium.length > 0 ? ok(join(browsers, chromium[0] ?? "")) : flunk(`no chromium under ${browsers}; run npx playwright install chromium`);
  },
};

const serviceChecks = (loaded: LoadedConfig, ctx: CliContext): Check[] => {
  const { config, configPath } = loaded;
  const healthUrl = `${config.server.publicUrl}/health`;
  return [
    {
      name: "public url",
      run: async () => {
        const response = await ctx.fetchImpl(healthUrl, { signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS) });
        return response.ok ? ok(`${healthUrl} answered ${response.status}`) : flunk(`${healthUrl} answered ${response.status}`);
      },
    },
    {
      name: "codehost mcp",
      run: async () => {
        const spec = (ctx.factories?.codehostMcpSpec ?? codehostMcpSpec)({ binPath, configPath, worktreePath: config.dataDir, sha: "HEAD" });
        const client = new Client({ name: "steward-doctor", version: "0.1.0" });
        const transport = new StdioClientTransport({ command: spec.command, args: spec.args, env: spec.env, stderr: "pipe" });
        try {
          await withTimeout(client.connect(transport), MCP_TIMEOUT_MS, "codehost MCP connect");
          const { tools } = await withTimeout(client.listTools(), MCP_TIMEOUT_MS, "tools/list");
          return ok(`tools: ${tools.map((tool) => tool.name).join(", ")}`);
        } finally {
          await client.close();
        }
      },
    },
    {
      name: "playwright mcp",
      run: async () => ok(createRequire(import.meta.url).resolve("@playwright/mcp/package.json")),
    },
    // On Kubernetes, Chromium and the app port are the agent image's and the run pod's; the probe pod covers the run pod.
    ...(kubernetesRuntime(config) === null ? [chromiumCheck, ...portChecks(loaded, ctx)] : []),
  ];
};

const ORBIT_VERSION_TIMEOUT_MS = 10_000;

/**
 * The Orbit CLI runs (`[ok]` with its version) and its remote API answers for the project with GITLAB_TOKEN. Neither
 * fails doctor: agents work without Orbit, and a remote outage only turns its tools into error results.
 */
const orbitChecks = ({ config, secrets }: LoadedConfig, ctx: CliContext): Check[] => {
  const exec = ctx.factories?.orbitExec ?? execOrbit;
  const remote = orbitRemote({ exec, dataDir: config.dataDir, worktreePath: config.dataDir, codehost: config.codehost, secrets });
  return [
    {
      name: "orbit",
      run: async () => {
        const run = await exec(["version"], { cwd: config.dataDir, env: orbitEnv(config.dataDir), timeoutMs: ORBIT_VERSION_TIMEOUT_MS });
        const version = run.stdout.trim();
        return run.exitCode === 0 && version !== "" ? ok(version) : warn(`orbit did not run (${run.stderr.trim() || `exit ${run.exitCode ?? "none"}`}); agents work without Orbit`);
      },
    },
    {
      name: "orbit remote",
      run: async () => {
        const project = config.codehost.kind === "gitlab" ? config.codehost.project : "";
        const result = await runOrbitTool(remote, ["status", "--full-path", project, "--response-format", "raw"]);
        const text = result.content[0]?.text ?? "";
        return result.isError === true ? warn(`${text}; the agents' orbit_* tools return this error`) : ok(`${project} answered with GITLAB_TOKEN`);
      },
    },
  ];
};

/**
 * A config that does not load, on one line: each schema issue as `path: message` (a message that already names its key,
 * such as a removed key's, as it is), anything else as its message.
 */
const configError = (err: unknown): string => {
  if (!(err instanceof z.ZodError)) return errorMessage(err);
  return err.issues
    .map((issue) => {
      const path = issue.path.map(String).join(".");
      return path === "" || issue.message.startsWith(`${path}:`) ? issue.message : `${path}: ${issue.message}`;
    })
    .join("; ");
};

const runChecks = async (checks: Check[], ctx: CliContext): Promise<boolean> => {
  let failed = false;
  for (const check of checks) {
    const result = await check.run().catch((err: unknown) => flunk(errorMessage(err)));
    println(ctx, `[${result.level}] ${check.name}: ${result.message}`);
    failed = failed || result.level === "fail";
  }
  return failed;
};

const configChecks = (loaded: LoadedConfig, ctx: CliContext, opts: { probePod: boolean }): Check[] => {
  const kubernetes = kubernetesRuntime(loaded.config);
  return [
    ...secretChecks(loaded),
    userCheck,
    ...workspaceChecks(loaded),
    ...linearChecks(loaded, ctx),
    ...implementChecks(loaded, ctx),
    ...greptileChecks(loaded, ctx),
    ...serviceChecks(loaded, ctx),
    ...orbitChecks(loaded, ctx),
    ...(kubernetes === null ? [] : kubernetesChecks(loaded, kubernetes, kubernetesDoctorDeps(ctx, loaded, kubernetes), opts)),
  ];
};

export const registerDoctor = (program: Command, ctx: CliContext): void => {
  program
    .command("doctor")
    .description("run every health check, report all of them, exit 1 if any fails")
    .option("--probe-pod", "on the kubernetes runtime: start a throwaway run-like pod and check its agent container holds no token and cannot reach the API server")
    .action(async (opts: { probePod?: boolean }) => {
      let loaded: LoadedConfig;
      try {
        loaded = await loadFromProgram(program, ctx, { linear: true });
      } catch (err) {
        println(ctx, `[fail] config: ${configError(err)}`);
        await runChecks([userCheck], ctx);
        return exitWith(ctx, 1);
      }
      println(ctx, `[ok] config: ${loaded.configPath}`);
      if (await runChecks(configChecks(loaded, ctx, { probePod: opts.probePod === true }), ctx)) exitWith(ctx, 1);
    });
};
