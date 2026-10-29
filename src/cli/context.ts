import type { Readable, Writable } from "node:stream";
import type { Command } from "commander";
import type { Brain } from "../brain/types.js";
import type { GitLabMrApi } from "../codehost/gitlabMr.js";
import type { codehostMcpSpec } from "../codehost/server.js";
import type { CodeHost } from "../codehost/types.js";
import { loadConfig, SecretsSchema, type LoadedConfig, type SecretName } from "../config/load.js";
import type { SecretFetcher } from "../config/secretSource.js";
import type { PodsApi } from "../k8s/chat.js";
import type { AttachTty } from "../k8s/cluster.js";
import type { ConfigMapsApi, JobsApi, JobWatch } from "../k8s/executor.js";
import type { OrbitExec } from "../orbit/run.js";
import type { ObjectStore } from "../sessions/store.js";
import type { TemplateListing, Tracker } from "../tracker/types.js";
import type { SlotRunner } from "../workspace/slots.js";
import type { AssumeWebIdentity, DoctorCluster, MinioSignIn, SimulateSecretRead } from "./doctorKubernetes.js";

export type { TemplateListing } from "../tracker/types.js";

/** The dispatcher's template listing behind the admin API's `/api/templates`. */
export interface TemplateLister {
  listTemplates(teamKeys: string[]): Promise<TemplateListing[]>;
}

/** Adapter overrides; tests inject fakes here instead of the real Linear, brain and code-host clients. */
export interface CliFactories {
  tracker?: Tracker;
  brain?: Brain;
  codehost?: CodeHost;
  gitlab?: GitLabMrApi;
  codehostMcpSpec?: typeof codehostMcpSpec;
  templates?: TemplateLister;
  /** Stands in for the slot helper's socket; tests never reach systemd or Docker. */
  slotRunner?: SlotRunner;
  /** Stands in for /usr/local/sbin/steward-slot in the helper ownership check. */
  slotHelperPath?: string;
  /** Stands in for /run/steward-slot.sock, the socket path that means the helper is installed on this host. */
  slotSystemdSocket?: string;
  /** Stands in for the Orbit CLI in doctor's Orbit checks. */
  orbitExec?: OrbitExec;
  /** Stands in for Secrets Manager in `render-overlay` and doctor's Kubernetes checks. */
  secretFetcher?: SecretFetcher;
  /** Stands in for the MinIO bucket in `sessions pull|push|sync` and doctor's Kubernetes checks. */
  objectStore?: ObjectStore;
  /** Stands in for the interactive Claude Code process `steward chat` runs; resolves to its exit code. */
  spawnInteractive?: SpawnInteractive;
  /** Stands in for the cluster on the Kubernetes runtime; without `pods`, serve's admin API launches no chat. */
  cluster?: { batch: JobsApi; core: ConfigMapsApi; pods?: PodsApi; watch?: JobWatch };
  /** Stands in for `steward chat`'s attach to the run pod's TTY on the Kubernetes runtime. */
  attachTty?: AttachTty;
  /** Stand in for the cluster, AWS STS and MinIO STS in doctor's Kubernetes checks. */
  doctorCluster?: DoctorCluster;
  assumeWebIdentity?: AssumeWebIdentity;
  minioSignIn?: MinioSignIn;
  /** Stands in for IAM's policy simulator in doctor's `run role` check. */
  simulateSecretRead?: SimulateSecretRead;
}

export type SpawnInteractive = (command: string, args: string[], options: { cwd: string; env: Record<string, string> }) => Promise<number>;

export interface CliContext {
  loadConfig: typeof loadConfig;
  stdout: Writable;
  stderr: Writable;
  /** What `chat-hook` reads its hook input from; process.stdin when unset. */
  stdin?: Readable;
  fetchImpl: typeof fetch;
  exit?: (code: number) => never;
  factories?: CliFactories;
}

export const defaultContext = (): CliContext => ({
  loadConfig,
  stdout: process.stdout,
  stderr: process.stderr,
  fetchImpl: fetch,
});

export const exitWith = (ctx: CliContext, code: number): never => {
  if (ctx.exit !== undefined) return ctx.exit(code);
  return process.exit(code);
};

export const println = (ctx: CliContext, line: string): void => {
  ctx.stdout.write(`${line}\n`);
};

export const fail = (ctx: CliContext, message: string, code = 1): never => {
  ctx.stderr.write(`${message}\n`);
  return exitWith(ctx, code);
};

export const errorMessage = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/** Every secret but the Linear app's: the CLI never holds a Linear credential, so its commands load these at most. */
export const CLI_SECRET_NAMES: readonly SecretName[] = SecretsSchema.keyof().options.filter((name) => !name.startsWith("LINEAR_"));

/**
 * Loads the config named by the root `--config` option, or the one in the current directory; `withoutSecrets` reads
 * none, `secrets` only those names, and by default `CLI_SECRET_NAMES`. Only `linear` (serve, which holds the Linear
 * token, and doctor, which checks the app's credentials) reads every secret.
 */
export const loadFromProgram = (
  program: Command,
  ctx: CliContext,
  opts: { withoutSecrets?: boolean; secrets?: readonly SecretName[]; linear?: boolean } = {},
): Promise<LoadedConfig> => {
  const { config } = program.opts<{ config?: string }>();
  if (opts.withoutSecrets === true) return ctx.loadConfig({ ...(config === undefined ? {} : { configPath: config }), withoutSecrets: true });
  return ctx.loadConfig({
    ...(config === undefined ? {} : { configPath: config }),
    ...(opts.linear === true ? {} : { secretNames: opts.secrets ?? CLI_SECRET_NAMES }),
  });
};
