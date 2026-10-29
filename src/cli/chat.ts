import { spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { createRequire } from "node:module";
import type { Readable } from "node:stream";
import { join } from "node:path";
import type { Command } from "commander";
import { claudeMcpServer, CLEANUP_PERIOD_DAYS } from "../brain/claudeCode.js";
import type { PolicyDecision } from "../brain/policy.js";
import { buildBrainEnv } from "../brain/env.js";
import { chatSettings, evaluateHook, HOOK_DENY_EXIT } from "../chat/hook.js";
import { acquireLease, HEARTBEAT_MS, holdLease } from "../chat/lease.js";
import { leftoverWork, sessionPushTarget } from "../chat/run.js";
import { ensureWorktree, latestSession, type AgentSession } from "../chat/session.js";
import { appPortOf, kubernetesRuntime } from "../config/schema.js";
import { brainDenyPaths, brainInput, sessionsDir, type JobPaths } from "../core/workspace.js";
import { attachTty } from "../k8s/cluster.js";
import { freePort, isPortFree } from "../workspace/retention.js";
import type { Slot } from "../workspace/slots.js";
import { connectAdmin, type AdminClient, type ChatClosed } from "./client.js";
import { errorMessage, exitWith, fail, loadFromProgram, println, type CliContext, type SpawnInteractive } from "./context.js";
import { jobsDir, mirrorPath, workRoot } from "./paths.js";
import { buildRuntime, CLI_SECRET_NAMES, type Runtime } from "./runtime.js";

const NO_FREE_SLOT = "no slot is free: every slot runs a job or another chat. Retry when one finishes, or pass --no-slot to chat without slot services";

/** The Claude Code binary the Agent SDK runs (its platform package), else `claude` on PATH. */
export const claudeExecutable = (): string => {
  const sdkRequire = createRequire(createRequire(import.meta.url).resolve("@anthropic-ai/claude-agent-sdk"));
  const base = `@anthropic-ai/claude-agent-sdk-${process.platform}-${process.arch}`;
  for (const pkg of [base, `${base}-musl`]) {
    try {
      return sdkRequire.resolve(`${pkg}/claude`);
    } catch {
      // Not installed for this platform or libc; try the next.
    }
  }
  return "claude";
};

/**
 * Runs the CLI attached to this terminal. Ctrl-C belongs to Claude Code while it runs: the steward ignores SIGINT until it
 * exits, so it can still release the lease and the slot.
 */
export const spawnInteractive: SpawnInteractive = (command, args, options) =>
  new Promise((resolve, reject) => {
    const ignore = (): void => undefined;
    process.on("SIGINT", ignore);
    const child = spawn(command, args, { cwd: options.cwd, env: options.env, stdio: "inherit" });
    const done = (): void => void process.removeListener("SIGINT", ignore);
    child.once("error", (err) => {
      done();
      reject(err);
    });
    child.once("exit", (code) => {
      done();
      resolve(code ?? 1);
    });
  });

const readAll = async (stream: Readable): Promise<string> => {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : Buffer.from(chunk as Uint8Array));
  return Buffer.concat(chunks).toString("utf8");
};

/** The CLI's arguments: the session resumed with the brain's model, MCP servers only the steward's, the policy as a hook. */
export const chatArgs = (p: { sessionId: string; model: string; settings: Record<string, unknown>; mcpServers: Record<string, unknown> }): string[] => [
  "--resume",
  p.sessionId,
  "--model",
  p.model,
  "--setting-sources",
  "project",
  "--settings",
  JSON.stringify(p.settings),
  "--mcp-config",
  JSON.stringify({ mcpServers: p.mcpServers }),
  "--strict-mcp-config",
];

/**
 * One terminal session on a leased slot (0: none): the slot up, the worktree ready, Claude Code resumed in it with the
 * brain's env, MCP servers and tool rules. Afterwards it says what was left unpushed, frees the port and brings the slot down.
 */
const converse = async (ctx: CliContext, runtime: Runtime, ticket: { id: string; identifier: string }, session: AgentSession, slotNumber: number): Promise<number> => {
  const { deps } = runtime;
  const { config, secrets } = runtime.loaded;
  const port = appPortOf(config, slotNumber);
  const env = buildBrainEnv(secrets, config.brain, port, sessionsDir(config), config.implement?.commitAuthor);
  // Only a leased slot's port is the chat's to free; without one (`--no-slot`) another run may own it.
  const owned = slotNumber > 0;
  const client = owned ? deps.slot?.client : undefined;
  let slot: Slot | null = null;
  try {
    if (owned && !(await isPortFree(port))) await freePort(port);
    if (client !== undefined) slot = { n: slotNumber, appPort: port, ports: await client.start(slotNumber) };
    const worktree = await ensureWorktree(deps, session, { env, port, slot });
    const jobDir = join(jobsDir(config.dataDir), `chat-${ticket.identifier}`);
    const paths: JobPaths = {
      worktreeName: session.worktreeName,
      jobDir,
      workRoot: workRoot(config.dataDir),
      artifactsDir: join(jobDir, "artifacts"),
      transcriptPath: join(jobDir, "transcript.jsonl"),
    };
    await mkdir(paths.artifactsDir, { recursive: true, mode: 0o700 });
    // No job runs a terminal chat: its pushes are recorded on the session's implement job (with the loop, when there is one).
    const push = sessionPushTarget(deps, session, worktree, { jobId: session.jobId, identifier: ticket.identifier, issueId: ticket.id, port });
    const input = brainInput(deps, paths, worktree, "", env, "chat", { resumeSessionId: session.sessionId, ...(push === undefined ? {} : { push }) });
    const mcpServers = Object.fromEntries(Object.entries(input.mcpServers).map(([name, spec]) => [name, claudeMcpServer(spec)]));
    const settings = chatSettings({
      nodePath: process.execPath,
      binPath: deps.binPath,
      configPath: deps.configPath,
      workspacePath: worktree.path,
      artifactsDir: paths.artifactsDir,
      cleanupPeriodDays: CLEANUP_PERIOD_DAYS,
    });
    const where = slot === null ? "without slot services" : `on slot ${slot.n}`;
    const pushing = push === undefined ? "nothing is pushed yet, so it has no push tool" : `the push tool pushes to ${push.branch ?? ""}`;
    println(ctx, `resuming ${ticket.identifier}'s agent session in ${worktree.path} ${where}; ${pushing}`);
    const run = ctx.factories?.spawnInteractive ?? spawnInteractive;
    const code = await run(claudeExecutable(), chatArgs({ sessionId: session.sessionId, model: config.brain.model, settings, mcpServers }), { cwd: worktree.path, env: input.env });
    const leftover = await leftoverWork(deps, session, worktree, push);
    if (leftover !== "") println(ctx, `Left in the agent's worktree, not pushed:\n${leftover}`);
    return code;
  } finally {
    if (owned && !(await isPortFree(port))) await freePort(port);
    if (slot !== null) await client?.release(slot.n);
  }
};

/** Exit codes of a chat ended by a signal, as a shell reports them. */
const SIGNAL_EXIT: Partial<Record<NodeJS.Signals, number>> = { SIGHUP: 129, SIGINT: 130 };

/**
 * `steward chat` on Kubernetes, as the admin API's client: serve takes the lease and starts the ticket's interactive run
 * pod, this terminal attaches to its agent container's TTY, and the lease is heartbeated until the person leaves Claude
 * Code, or this process gets SIGINT or SIGHUP; then it is released, after serve has ended the run.
 */
const chatInRunPod = async (ctx: CliContext, client: AdminClient, namespace: string, key: string): Promise<void> => {
  let opened;
  try {
    opened = await client.openChat(key, process.pid);
  } catch (err) {
    return fail(ctx, errorMessage(err));
  }
  println(ctx, `attaching to ${opened.pod} for ${key}'s agent session; leave Claude Code to end the chat`);
  let closing: Promise<ChatClosed | null> | null = null;
  const close = (): Promise<ChatClosed | null> =>
    (closing ??= client.closeChat(key).catch((err: unknown) => {
      ctx.stderr.write(`could not release ${key}: ${errorMessage(err)}\n`);
      return null;
    }));
  const beat = setInterval(() => {
    // A missed beat is retried at the next; the lease goes stale only after four.
    client.heartbeat(key).catch(() => undefined);
  }, HEARTBEAT_MS);
  beat.unref();
  const onSignal = (signal: NodeJS.Signals): void => {
    void close().then(() => exitWith(ctx, SIGNAL_EXIT[signal] ?? 1));
  };
  process.once("SIGINT", onSignal);
  process.once("SIGHUP", onSignal);
  let attachError: string | null = null;
  try {
    const attach = ctx.factories?.attachTty ?? attachTty;
    await attach({ namespace, pod: opened.pod, container: opened.container, onWaiting: () => println(ctx, "waiting for the run pod: clone, overlay and session first") });
  } catch (err) {
    attachError = errorMessage(err);
  } finally {
    clearInterval(beat);
    process.off("SIGINT", onSignal);
    process.off("SIGHUP", onSignal);
  }
  const closed = await close();
  if (closed !== null && closed.unpushed !== null && closed.unpushed !== "") println(ctx, `Left in the agent's worktree, not pushed:\n${closed.unpushed}`);
  if (attachError !== null) return fail(ctx, `could not attach to ${opened.pod}: ${attachError}`);
  if (closed?.ok === false) return fail(ctx, `the chat's run failed: ${closed.error ?? "no error given"}`);
};

export const registerChat = (program: Command, ctx: CliContext): void => {
  program
    .command("chat")
    .description("resume a ticket's agent session in Claude Code, in its worktree, under the agent's tool rules (claude-code brain)")
    .argument("<ticket>", "issue key or UUID")
    .option("--no-slot", "chat without slot services (the app's containers) instead of leasing a slot")
    .action(async (key: string, opts: { slot: boolean }) => {
      const loaded = await loadFromProgram(program, ctx, { secrets: CLI_SECRET_NAMES });
      const { config } = loaded;
      if (config.brain.kind !== "claude-code") return fail(ctx, 'steward chat requires brain.kind "claude-code"');
      const kubernetes = kubernetesRuntime(config);
      if (kubernetes !== null) {
        const client = await connectAdmin(ctx, config).catch((err: unknown) => fail(ctx, errorMessage(err)));
        if (client === null) return fail(ctx, "steward chat on the kubernetes runtime goes through steward serve's admin API, which does not answer");
        return chatInRunPod(ctx, client, kubernetes.namespace, key);
      }
      const runtime = await buildRuntime(loaded, ctx);
      const ticket = await runtime.tracker.resolveIssueId(key);
      const session = latestSession(runtime.stores, ticket.id);
      if (session === null) return fail(ctx, `no agent session for ${ticket.identifier}`);
      const lease = acquireLease(runtime.stores, { issueId: ticket.id, identifier: ticket.identifier, worktreeName: session.worktreeName }, opts.slot ? (config.slots?.count ?? 1) : 0);
      if ("busy" in lease) return fail(ctx, lease.busy);
      const release = holdLease(runtime.stores, lease.leaseId);
      let code: number;
      try {
        if (opts.slot && lease.slot === 0) {
          release();
          return fail(ctx, NO_FREE_SLOT);
        }
        code = await converse(ctx, runtime, ticket, session, lease.slot);
      } finally {
        release();
      }
      if (code !== 0) return fail(ctx, `claude exited with code ${code}`, code);
    });

  // Claude Code's PreToolUse command hook for `steward chat`: the brain's tool rules, read per call from stdin.
  program
    .command("chat-hook", { hidden: true })
    .description("internal: PreToolUse hook enforcing the agent's tool rules for steward chat; needs the global --config")
    .requiredOption("--workspace <path>", "the session's worktree")
    .requiredOption("--artifacts <path>", "the session's artifacts directory")
    .option("--deny <path...>", "the paths the agent may not touch, in place of those derived from the config (a run pod)")
    .action(async (opts: { workspace: string; artifacts: string; deny?: string[] }) => {
      // Claude Code blocks only on exit 2; any other failure would let the tool run unchecked, so every error denies.
      let decision: PolicyDecision;
      try {
        let denyPaths = opts.deny;
        if (denyPaths === undefined) {
          const loaded = await loadFromProgram(program, ctx);
          denyPaths = brainDenyPaths(loaded.config, loaded.configPath, mirrorPath(loaded.config.dataDir));
        }
        decision = evaluateHook(await readAll(ctx.stdin ?? process.stdin), { workspacePath: opts.workspace, artifactsDir: opts.artifacts, denyPaths });
      } catch (err) {
        decision = { allow: false, reason: `the policy hook failed: ${errorMessage(err)}` };
      }
      if (!decision.allow) return fail(ctx, decision.reason, HOOK_DENY_EXIT);
    });
};

