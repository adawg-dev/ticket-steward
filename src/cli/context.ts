import type { Readable, Writable } from "node:stream";
import type { Command } from "commander";
import type { Brain } from "../brain/types.js";
import type { GitLabMrApi } from "../codehost/gitlabMr.js";
import type { codehostMcpSpec } from "../codehost/server.js";
import type { CodeHost } from "../codehost/types.js";
import { loadConfig, type LoadedConfig } from "../config/load.js";
import type { OrbitExec } from "../orbit/run.js";
import type { TicketBundle } from "../tracker/types.js";
import type { Tracker } from "../tracker/types.js";
import type { SlotRunner } from "../workspace/slots.js";

export interface TemplateListing {
  scope: string;
  template: TicketBundle["templates"][number];
}

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
  /** Stands in for the interactive Claude Code process `steward chat` runs; resolves to its exit code. */
  spawnInteractive?: SpawnInteractive;
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

/** Loads the config named by the root `--config` option, or the one in the current directory. */
export const loadFromProgram = (program: Command, ctx: CliContext): Promise<LoadedConfig> => {
  const { config } = program.opts<{ config?: string }>();
  return ctx.loadConfig(config === undefined ? {} : { configPath: config });
};
