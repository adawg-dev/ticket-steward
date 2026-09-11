import type { Writable } from "node:stream";
import type { Command } from "commander";
import type { Brain } from "../brain/types.js";
import type { codehostMcpSpec } from "../codehost/server.js";
import type { CodeHost } from "../codehost/types.js";
import { loadConfig, type LoadedConfig } from "../config/load.js";
import type { TicketBundle } from "../tracker/types.js";
import type { Tracker } from "../tracker/types.js";

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
  codehostMcpSpec?: typeof codehostMcpSpec;
  templates?: TemplateLister;
}

export interface CliContext {
  loadConfig: typeof loadConfig;
  stdout: Writable;
  stderr: Writable;
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
