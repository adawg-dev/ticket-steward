import { existsSync } from "node:fs";
import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { acquireLease } from "../../src/chat/lease.js";
import type { SpawnInteractive } from "../../src/cli/context.js";
import { buildProgram } from "../../src/cli/program.js";
import { openStores, type Stores } from "../../src/store/index.js";
import type { TicketBundle } from "../../src/tracker/types.js";
import { FakeBrain } from "../fakes/fakeBrain.js";
import { FakeCodeHost } from "../fakes/fakeCodeHost.js";
import { fakeSlotRunner, type FakeSlotRunner } from "../fakes/fakeSlotRunner.js";
import { FakeTracker } from "../fakes/fakeTracker.js";
import { freeTcpPort, tmpRepo, type TmpRepo } from "../fakes/tmpRepo.js";
import { ExitSignal, makeContext, tmpConfigDir, writeConfig } from "./helpers.js";

const IMPLEMENT_PROMPT = fileURLToPath(new URL("../../prompts/implement.md", import.meta.url));
const BRANCH = "fix/API-1-adapter";

const issue: TicketBundle = {
  id: "issue-1",
  identifier: "API-1",
  url: "https://linear.app/acme/issue/API-1",
  title: "Adapter drops the last chunk",
  description: "The adapter loses the final chunk.",
  team: { id: "team-1", key: "API", name: "API" },
  state: { name: "In Review", type: "started" },
  labels: ["agent-implemented"],
  priority: 2,
  creator: { name: "Ada", isBot: false },
  createdAt: "2026-10-27T00:00:00.000Z",
  comments: [],
  attachments: [],
  appliedTemplate: null,
  templates: [],
};

const McpConfig = z.object({ mcpServers: z.record(z.string(), z.object({ type: z.literal("stdio"), command: z.string(), args: z.array(z.string()) })) });
const Settings = z.object({
  cleanupPeriodDays: z.number(),
  disableAllHooks: z.literal(false),
  permissions: z.object({ defaultMode: z.literal("default"), disableBypassPermissionsMode: z.literal("disable") }),
  hooks: z.object({ PreToolUse: z.array(z.object({ matcher: z.string(), hooks: z.array(z.object({ type: z.literal("command"), command: z.string() })) })) }),
});

let dir: string;
let repo: TmpRepo;
let configPath: string;

interface Spawned {
  command: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
}

/** Opens the steward's store for one step of a test; closed before the command runs. */
const withStores = <T>(fn: (stores: Stores) => T): T => {
  const stores = openStores(repo.dataDir);
  try {
    return fn(stores);
  } finally {
    stores.db.close();
  }
};

/** An implement job on API-1 that left `session-1` in `ticket-API-1`; `pushed` gives it a pushed steward branch. */
const seedSession = (pushed: boolean): number =>
  withStores((stores) => {
    const id = stores.jobs.enqueue({ kind: "cli", issueId: "issue-1", identifier: "API-1", teamKey: "API", action: "implement" });
    stores.jobs.claimById(id);
    stores.jobs.recordWorkspace(id, "ticket-API-1", repo.sha);
    stores.jobs.recordSession(id, "session-1");
    if (pushed) {
      stores.jobs.recordCommit(id, BRANCH, repo.sha);
      stores.jobs.markPushed(id);
    }
    stores.jobs.finish(id, { status: "succeeded" });
    return id;
  });

const run = (args: string[], spawnInteractive?: SpawnInteractive, stdin?: string, slotRunner?: FakeSlotRunner) => {
  const context = makeContext({
    factories: {
      tracker: new FakeTracker([structuredClone(issue)]),
      codehost: new FakeCodeHost(),
      brain: new FakeBrain(),
      ...(spawnInteractive === undefined ? {} : { spawnInteractive }),
      ...(slotRunner === undefined ? {} : { slotRunner: slotRunner.run }),
    },
  });
  if (stdin !== undefined) context.ctx.stdin = Readable.from([stdin]);
  return { ...context, parse: () => buildProgram(context.ctx).parseAsync(["node", "steward", "--config", configPath, ...args]) };
};

const recorder = (act: (spawned: Spawned) => Promise<number> = async () => 0): { spawned: Spawned[]; spawn: SpawnInteractive } => {
  const spawned: Spawned[] = [];
  return {
    spawned,
    spawn: async (command, args, options) => {
      const call = { command, args, cwd: options.cwd, env: options.env };
      spawned.push(call);
      return act(call);
    },
  };
};

const argAfter = (args: string[], flag: string): string => args[args.indexOf(flag) + 1] ?? "";

beforeEach(async () => {
  dir = await tmpConfigDir();
  repo = await tmpRepo("unused");
  configPath = await writeConfig(dir, {
    dataDir: repo.dataDir,
    overlayDir: repo.overlayDir,
    fetchUrl: repo.repo,
    port: await freeTcpPort(),
    serverPort: await freeTcpPort(),
    implement: { prompt: IMPLEMENT_PROMPT },
  });
});

afterEach(async () => {
  await repo.cleanup();
  await rm(dir, { recursive: true, force: true });
});

describe("steward chat", () => {
  it("exits 1 when the ticket has no agent session", async () => {
    const { spawn, spawned } = recorder();
    const { parse, stderr } = run(["chat", "API-1"], spawn);

    await expect(parse()).rejects.toEqual(new ExitSignal(1));
    expect(stderr()).toContain("no agent session for API-1");
    expect(spawned).toEqual([]);
  });

  it("refuses while a job on the ticket runs, naming it", async () => {
    seedSession(true);
    const running = withStores((stores) => {
      const id = stores.jobs.enqueue({ kind: "cli", issueId: "issue-1", identifier: "API-1", teamKey: "API", action: "implement" });
      stores.jobs.claimById(id);
      return id;
    });
    const { spawn, spawned } = recorder();
    const { parse, stderr } = run(["chat", "API-1"], spawn);

    await expect(parse()).rejects.toEqual(new ExitSignal(1));
    expect(stderr()).toContain(`job ${running} (implement) is running for API-1`);
    expect(spawned).toEqual([]);
  });

  it("exits 1 when no slot is free, and without a slot under --no-slot", async () => {
    seedSession(false);
    withStores((stores) => acquireLease(stores, { issueId: "issue-9", identifier: "API-9", worktreeName: "ticket-API-9" }, 1));
    const refused = recorder();
    const first = run(["chat", "API-1"], refused.spawn);

    await expect(first.parse()).rejects.toEqual(new ExitSignal(1));
    expect(first.stderr()).toContain("pass --no-slot");
    expect(refused.spawned).toEqual([]);
    expect(withStores((stores) => stores.leases.active().map((lease) => lease.issueId))).toEqual(["issue-9"]);

    const { spawn, spawned } = recorder();
    const second = run(["chat", "API-1", "--no-slot"], spawn);
    await second.parse();
    expect(spawned).toHaveLength(1);
    expect(second.stdout()).toContain("without slot services");
  });

  it("resumes the session in its recreated worktree with the brain's env, MCP servers and policy hook, then releases the lease", async () => {
    const implementJob = seedSession(true);
    let leasedDuringRun: string[] = [];
    const { spawn, spawned } = recorder(async (call) => {
      leasedDuringRun = withStores((stores) => stores.leases.active().map((lease) => lease.worktreeName));
      await writeFile(join(call.cwd, "notes.txt"), "left behind\n");
      return 0;
    });
    const { parse, stdout } = run(["chat", "API-1"], spawn);

    await parse();

    const worktree = join(repo.dataDir, "work", "ticket-API-1");
    expect(existsSync(join(worktree, "src", "adapter.ts"))).toBe(true);
    expect(spawned).toHaveLength(1);
    const [call] = spawned;
    if (call === undefined) throw new Error("not spawned");
    expect(call.command).toMatch(/claude$/);
    expect(call.cwd).toBe(worktree);
    expect(argAfter(call.args, "--resume")).toBe("session-1");
    expect(argAfter(call.args, "--model")).toBe("claude-test");
    expect(call.args).toContain("--strict-mcp-config");
    expect(call.env).toMatchObject({ CLAUDE_CONFIG_DIR: join(repo.dataDir, "sessions"), GIT_AUTHOR_NAME: "Ticket Steward", ORBIT_DATA_DIR: join(repo.dataDir, "orbit") });
    expect(JSON.stringify(call)).not.toContain("glpat-push-token-value");

    const mcp = McpConfig.parse(JSON.parse(argAfter(call.args, "--mcp-config")));
    expect(Object.keys(mcp.mcpServers).sort()).toEqual(["codehost", "orbit", "playwright", "push"]);
    const pushArgs = mcp.mcpServers.push?.args ?? [];
    expect(JSON.parse(argAfter(pushArgs, "--target"))).toMatchObject({ jobId: implementJob, mode: "fastForward", branch: BRANCH, baseSha: repo.sha, loopId: null, worktreePath: worktree });

    const settings = Settings.parse(JSON.parse(argAfter(call.args, "--settings")));
    const hook = settings.hooks.PreToolUse[0];
    expect(hook?.matcher).toContain("Bash");
    expect(hook?.hooks[0]?.command).toContain(`'chat-hook' '--workspace' '${worktree}'`);
    expect(hook?.hooks[0]?.command).toContain(`'--config' '${configPath}'`);

    expect(leasedDuringRun).toEqual(["ticket-API-1"]);
    expect(withStores((stores) => stores.leases.active())).toEqual([]);
    expect(stdout()).toContain("Left in the agent's worktree, not pushed:");
    expect(stdout()).toContain("notes.txt");
  });

  it("with slots, starts the slot a running job does not hold, runs on its port, and brings it down afterwards", async () => {
    const appPortBase = await freeTcpPort();
    configPath = await writeConfig(dir, {
      dataDir: repo.dataDir,
      overlayDir: repo.overlayDir,
      fetchUrl: repo.repo,
      port: null,
      serverPort: await freeTcpPort(),
      implement: { prompt: IMPLEMENT_PROMPT },
      slots: { count: 2, socket: join(dir, "slot.sock"), appPortBase, env: {} },
    });
    seedSession(false);
    withStores((stores) => {
      stores.jobs.enqueue({ kind: "cli", issueId: "issue-2", identifier: "API-2", teamKey: "API", action: "implement" });
      stores.jobs.claimNext({ slot: 1 });
    });
    const runner = fakeSlotRunner();
    let callsDuringRun: string[][] = [];
    const { spawn, spawned } = recorder(async () => {
      callsDuringRun = runner.calls.map((call) => [...call]);
      return 0;
    });
    const { parse, stdout } = run(["chat", "API-1"], spawn, undefined, runner);

    await parse();

    expect(stdout()).toContain("on slot 2");
    expect(spawned[0]?.env.PORT).toBe(String(appPortBase + 2));
    expect(callsDuringRun.some((call) => call[0] === "up" && call[1] === "2")).toBe(true);
    expect(runner.calls.slice(callsDuringRun.length)).toEqual([["down", "2"]]);
  });

  it("gives a session with nothing pushed no push tool", async () => {
    seedSession(false);
    const { spawn, spawned } = recorder();
    const { parse, stdout } = run(["chat", "API-1"], spawn);

    await parse();

    const mcp = McpConfig.parse(JSON.parse(argAfter(spawned[0]?.args ?? [], "--mcp-config")));
    expect(Object.keys(mcp.mcpServers).sort()).toEqual(["codehost", "orbit", "playwright"]);
    expect(stdout()).toContain("no push tool");
  });

  it("exits with Claude Code's exit code and still releases the lease", async () => {
    seedSession(false);
    const { spawn } = recorder(async () => 3);
    const { parse } = run(["chat", "API-1"], spawn);

    await expect(parse()).rejects.toEqual(new ExitSignal(3));
    expect(withStores((stores) => stores.leases.active())).toEqual([]);
  });
});

describe("steward chat-hook", () => {
  const hookInput = (tool: string, input: Record<string, unknown>): string =>
    JSON.stringify({ session_id: "s", hook_event_name: "PreToolUse", tool_name: tool, tool_input: input });

  const hook = (stdin: string, workspace = "/work/ticket-API-1") =>
    run(["chat-hook", "--workspace", workspace, "--artifacts", "/jobs/chat-API-1/artifacts"], undefined, stdin);

  it("denies git push with exit 2 and the reason on stderr", async () => {
    const { parse, stderr } = hook(hookInput("Bash", { command: "git push origin HEAD" }));

    await expect(parse()).rejects.toEqual(new ExitSignal(2));
    expect(stderr()).toContain("denied pattern");
  });

  it("denies a write outside the worktree with exit 2", async () => {
    const { parse, stderr } = hook(hookInput("Write", { file_path: "/etc/passwd", content: "x" }));

    await expect(parse()).rejects.toEqual(new ExitSignal(2));
    expect(stderr()).toContain("outside the worktree");
  });

  it("denies a read of the steward's database", async () => {
    const { parse } = hook(hookInput("Read", { file_path: join(repo.dataDir, "steward.db") }));

    await expect(parse()).rejects.toEqual(new ExitSignal(2));
  });

  it("allows a commit and a write inside the worktree", async () => {
    await hook(hookInput("Bash", { command: "git commit -m 'fix'" })).parse();
    await hook(hookInput("Edit", { file_path: "/work/ticket-API-1/src/a.ts", old_string: "a", new_string: "b" })).parse();
  });

  it("denies input that is not a hook payload", async () => {
    const { parse, stderr } = hook("not json");

    await expect(parse()).rejects.toEqual(new ExitSignal(2));
    expect(stderr()).toContain("could not read its input");
  });
});
