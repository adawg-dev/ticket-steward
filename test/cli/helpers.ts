import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";
import { loadConfig } from "../../src/config/load.js";
import type { CliContext, CliFactories } from "../../src/cli/context.js";

export class ExitSignal extends Error {
  constructor(readonly code: number) {
    super(`exit ${code}`);
  }
}

export interface TestContext {
  ctx: CliContext;
  stdout: () => string;
  stderr: () => string;
}

const collector = (chunks: string[]): Writable =>
  new Writable({
    write(chunk: Buffer | string, _encoding, callback) {
      chunks.push(chunk.toString());
      callback();
    },
  });

export const rejectingFetch: typeof fetch = async () => {
  throw new Error("Intended Test Error");
};

export const makeContext = (overrides: { fetchImpl?: typeof fetch; factories?: CliFactories } = {}): TestContext => {
  const out: string[] = [];
  const err: string[] = [];
  const ctx: CliContext = {
    loadConfig,
    stdout: collector(out),
    stderr: collector(err),
    fetchImpl: overrides.fetchImpl ?? rejectingFetch,
    exit: (code) => {
      throw new ExitSignal(code);
    },
    ...(overrides.factories === undefined ? {} : { factories: overrides.factories }),
  };
  return { ctx, stdout: () => out.join(""), stderr: () => err.join("") };
};

export const tmpConfigDir = (): Promise<string> => mkdtemp(join(tmpdir(), "steward-cli-"));

export interface ConfigPaths {
  dataDir: string;
  overlayDir: string;
  promptPath: string;
  fetchUrl: string;
  port: number;
  serverPort: number;
  skillsDir?: string;
  teams?: string[];
}

/** Writes a steward.config.ts into `dir` pointing at the given paths and returns its path. */
export const writeConfig = async (dir: string, p: ConfigPaths): Promise<string> => {
  const skills = p.skillsDir === undefined ? "" : `skillsDir: ${JSON.stringify(p.skillsDir)},`;
  const source = `
import { defineConfig } from "ticket-steward";
export default defineConfig({
  dataDir: ${JSON.stringify(p.dataDir)},
  brain: { kind: "claude-code", model: "claude-test", maxTurns: 5, timeoutMinutes: 1 },
  tracker: { kind: "linear", teams: ${JSON.stringify(p.teams ?? ["API"])} },
  codehost: { kind: "gitlab", baseUrl: "https://gitlab.example", project: "acme/repo" },
  workspace: {
    fetchUrl: ${JSON.stringify(p.fetchUrl)},
    baseBranch: "main",
    overlayDir: ${JSON.stringify(p.overlayDir)},
    ${skills}
    setup: [],
    setupTimeoutMinutes: 1,
    port: ${p.port},
    keepOnFailure: true,
  },
  retention: { keptWorktrees: 3, days: 30 },
  prompt: ${JSON.stringify(p.promptPath)},
  server: { port: ${p.serverPort}, publicUrl: "https://steward.example" },
});
`;
  const configPath = join(dir, "steward.config.ts");
  await writeFile(configPath, source);
  return configPath;
};

/** Polls until `predicate` holds; rejects after `timeoutMs`. */
export const waitFor = async (predicate: () => boolean, timeoutMs = 5_000): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("waitFor timed out");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
};
