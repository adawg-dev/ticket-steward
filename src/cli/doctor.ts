import { existsSync } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { Command } from "commander";
import { z } from "zod";
import { codehostMcpSpec } from "../codehost/server.js";
import type { LoadedConfig } from "../config/load.js";
import { openStores, type Stores } from "../store/index.js";
import { LinearAuth } from "../tracker/linear/index.js";
import { listFiles } from "../workspace/files.js";
import { isPortFree } from "../workspace/retention.js";
import { errorMessage, exitWith, loadFromProgram, println, type CliContext } from "./context.js";
import { binPath } from "./paths.js";
import { withTimeout } from "./probe.js";
import { openMirror } from "./runtime.js";

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

const ViewerResponse = z.object({ data: z.object({ viewer: z.object({ id: z.string() }) }) });

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
      name: "tracker secrets",
      run: async () => {
        const absent = missing(secrets, ["LINEAR_CLIENT_ID", "LINEAR_CLIENT_SECRET", "LINEAR_WEBHOOK_SECRET"]);
        return absent.length === 0 ? ok("LINEAR_CLIENT_ID, LINEAR_CLIENT_SECRET, LINEAR_WEBHOOK_SECRET present") : flunk(`missing ${absent.join(", ")}`);
      },
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

const linearChecks = (loaded: LoadedConfig, stores: () => Stores, ctx: CliContext): Check[] => [
  {
    name: "linear token",
    run: async () => {
      const { LINEAR_CLIENT_ID: clientId, LINEAR_CLIENT_SECRET: clientSecret } = loaded.secrets;
      if (stores().tokens.get() === null) return flunk("no token stored; run steward auth linear");
      if (clientId === undefined || clientSecret === undefined) return warn("cannot validate without LINEAR_CLIENT_ID and LINEAR_CLIENT_SECRET");
      const token = await new LinearAuth(stores().tokens, { clientId, clientSecret }, ctx.fetchImpl).accessToken();
      const response = await ctx.fetchImpl(LINEAR_GRAPHQL_URL, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
        body: JSON.stringify({ query: "{ viewer { id } }" }),
        signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS),
      });
      if (!response.ok) return flunk(`viewer query answered ${response.status}`);
      return ok(`viewer ${ViewerResponse.parse(await response.json()).data.viewer.id}`);
    },
  },
  {
    name: "auth_broken",
    run: async () => (stores().tokens.isAuthBroken() ? flunk("set; run steward auth linear") : ok("clear")),
  },
];

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
      run: async () => ((await isPortFree(config.workspace.port)) ? ok(`${config.workspace.port} is free`) : flunk(`${config.workspace.port} is in use`)),
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

const configChecks = (loaded: LoadedConfig, ctx: CliContext): Check[] => {
  let opened: Stores | null = null;
  const stores = (): Stores => (opened ??= openStores(loaded.config.dataDir));
  return [...secretChecks(loaded), userCheck, ...workspaceChecks(loaded), ...linearChecks(loaded, stores, ctx), ...serviceChecks(loaded, ctx)];
};

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
