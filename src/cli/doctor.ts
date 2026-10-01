import { existsSync } from "node:fs";
import { mkdir, readdir, rm, stat } from "node:fs/promises";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { Command } from "commander";
import { z } from "zod";
import { createGitLabReview } from "../codehost/gitlabReview.js";
import { listProtectedBranches, protectionProblems } from "../codehost/gitlabProtection.js";
import { codehostMcpSpec } from "../codehost/server.js";
import type { LoadedConfig } from "../config/load.js";
import { listFiles } from "../workspace/files.js";
import { git, scrubCredentials } from "../workspace/git.js";
import { injectToken, splitCredentials } from "../workspace/mirror.js";
import { isPortFree } from "../workspace/retention.js";
import { errorMessage, exitWith, loadFromProgram, println, type CliContext } from "./context.js";
import { binPath } from "./paths.js";
import { withTimeout } from "./probe.js";
import { openMirror } from "./runtime.js";
import { appPortOf } from "../config/schema.js";

type Level = "ok" | "fail" | "warn";

interface CheckResult {
  level: Level;
  message: string;
}

interface Check {
  name: string;
  run: () => Promise<CheckResult>;
}

const HEALTH_TIMEOUT_MS = 3_000;
const MCP_TIMEOUT_MS = 10_000;
const LINEAR_GRAPHQL_URL = "https://api.linear.app/graphql";
const playwrightBrowsersPath = (): string => process.env.PLAYWRIGHT_BROWSERS_PATH ?? join(homedir(), ".cache", "ms-playwright");
const SENSITIVE_HOME_DIRS = [".ssh", ".kube"];

const ViewerResponse = z.object({ data: z.object({ viewer: z.object({ id: z.string(), name: z.string() }) }) });
const LabelsResponse = z.object({ data: z.object({ issueLabels: z.object({ nodes: z.array(z.object({ name: z.string() })) }) }) });
const GraphqlErrors = z.object({ errors: z.array(z.object({ extensions: z.object({ code: z.string().optional() }).optional() })) });

const ok = (message: string): CheckResult => ({ level: "ok", message });
const flunk = (message: string): CheckResult => ({ level: "fail", message });
const warn = (message: string): CheckResult => ({ level: "warn", message });

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

const workspaceChecks = (loaded: LoadedConfig): Check[] => {
  const { config } = loaded;
  return [
    modeCheck("dataDir", config.dataDir),
    modeCheck("overlayDir", config.workspace.overlayDir),
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
    {
      name: "overlay",
      run: async () => {
        if (!existsSync(config.workspace.overlayDir)) return flunk(`${config.workspace.overlayDir} missing; run steward overlay sync`);
        const files = await listFiles(config.workspace.overlayDir);
        return files.length > 0 ? ok(`${files.length} file(s)`) : flunk("overlay is empty; run steward overlay sync");
      },
    },
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

const linearChecks = ({ secrets }: LoadedConfig, ctx: CliContext): Check[] => [
  {
    name: "linear api key",
    run: async () => {
      const apiKey = secrets.LINEAR_API_KEY;
      if (apiKey === undefined || apiKey === "") return flunk("missing LINEAR_API_KEY; create a personal API key for the steward's Linear user");
      const response = await ctx.fetchImpl(LINEAR_GRAPHQL_URL, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: apiKey },
        body: JSON.stringify({ query: "{ viewer { id name } }" }),
        signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS),
      });
      const body: unknown = await response.json().catch(() => undefined);
      if (isAuthenticationError(response.status, body)) return flunk("Linear rejected LINEAR_API_KEY: the key is invalid or revoked");
      if (!response.ok) return flunk(`viewer query answered ${response.status}`);
      const { name } = ViewerResponse.parse(body).data.viewer;
      return ok(`authenticated as ${name}; every steward write appears as this user, so use a dedicated bot user`);
    },
  },
];

const reviewChecks = (loaded: LoadedConfig, ctx: CliContext): Check[] => {
  const { config, secrets } = loaded;
  const settings = config.review;
  if (settings === undefined) return [];
  const api = ctx.factories?.review ?? createGitLabReview(config, secrets);
  return [
    {
      name: "gitlab webhook secret",
      run: async () => {
        // A whsec_ value makes GitLab sign deliveries, and signatures are only checked against GITLAB_WEBHOOK_SIGNING_TOKEN.
        if (secrets.GITLAB_WEBHOOK_SECRET?.startsWith("whsec_") === true && missing(secrets, ["GITLAB_WEBHOOK_SIGNING_TOKEN"]).length > 0) {
          return flunk("GITLAB_WEBHOOK_SECRET holds a whsec_ signing token; rename it to GITLAB_WEBHOOK_SIGNING_TOKEN");
        }
        const present = ["GITLAB_WEBHOOK_SIGNING_TOKEN", "GITLAB_WEBHOOK_SECRET"].filter((key) => missing(secrets, [key]).length === 0);
        return present.length > 0 ? ok(`${present.join(", ")} present`) : flunk("set GITLAB_WEBHOOK_SIGNING_TOKEN or GITLAB_WEBHOOK_SECRET");
      },
    },
    {
      name: "gitlab reviewer",
      run: async () => {
        if (api === undefined) return flunk("GITLAB_TOKEN is missing");
        const [user, scopes] = await Promise.all([api.currentUser(), api.tokenScopes()]);
        if (!scopes.includes("api")) return flunk("GITLAB_TOKEN lacks the api scope; the steward cannot post review comments");
        if (user.username !== settings.botUsername) return flunk(`GITLAB_TOKEN acts as ${user.username}, but review.botUsername is ${settings.botUsername}`);
        return ok(`GITLAB_TOKEN acts as ${user.username} with the api scope`);
      },
    },
  ];
};

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
  const labels = config.tracker.labels;
  const checks: Check[] = [];
  if (labels !== undefined) {
    checks.push({
      name: "linear labels",
      run: async () => {
        const apiKey = secrets.LINEAR_API_KEY ?? "";
        const names = [labels.triage, labels.implement, labels.needsInfo, labels.readyForHuman, labels.implemented];
        const response = await ctx.fetchImpl(LINEAR_GRAPHQL_URL, {
          method: "POST",
          headers: { "content-type": "application/json", authorization: apiKey },
          body: JSON.stringify({ query: "query($names: [String!]) { issueLabels(first: 250, filter: { name: { in: $names } }) { nodes { name } } }", variables: { names } }),
          signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS),
        });
        if (!response.ok) return flunk(`issueLabels answered ${response.status}`);
        const found = new Set(LabelsResponse.parse(await response.json()).data.issueLabels.nodes.map((node) => node.name.toLowerCase()));
        const absent = names.filter((name) => !found.has(name.toLowerCase()));
        return absent.length === 0 ? ok(names.join(", ")) : flunk(`missing in Linear: ${absent.join(", ")}`);
      },
    });
  }
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
    {
      name: "chromium",
      run: async () => {
        const browsers = playwrightBrowsersPath();
        const entries = existsSync(browsers) ? await readdir(browsers) : [];
        const chromium = entries.filter((entry) => entry.startsWith("chromium"));
        return chromium.length > 0 ? ok(join(browsers, chromium[0] ?? "")) : flunk(`no chromium under ${browsers}; run npx playwright install chromium`);
      },
    },
    {
      name: "port",
      run: async () => {
        const port = appPortOf(config, 1);
        return (await isPortFree(port)) ? ok(`${port} is free`) : flunk(`${port} is in use`);
      },
    },
  ];
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

const configChecks = (loaded: LoadedConfig, ctx: CliContext): Check[] => [
  ...secretChecks(loaded),
  userCheck,
  ...workspaceChecks(loaded),
  ...linearChecks(loaded, ctx),
  ...reviewChecks(loaded, ctx),
  ...implementChecks(loaded, ctx),
  ...serviceChecks(loaded, ctx),
];

export const registerDoctor = (program: Command, ctx: CliContext): void => {
  program
    .command("doctor")
    .description("run every health check, report all of them, exit 1 if any fails")
    .action(async () => {
      let loaded: LoadedConfig;
      try {
        loaded = await loadFromProgram(program, ctx);
      } catch (err) {
        println(ctx, `[fail] config: ${errorMessage(err)}`);
        await runChecks([userCheck], ctx);
        return exitWith(ctx, 1);
      }
      println(ctx, `[ok] config: ${loaded.configPath}`);
      if (await runChecks(configChecks(loaded, ctx), ctx)) exitWith(ctx, 1);
    });
};
