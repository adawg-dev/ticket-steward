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
  /** null leaves workspace.port out (required with `slots`). */
  port: number | null;
  slots?: Record<string, unknown>;
  serverPort: number;
  skillsDir?: string;
  teams?: string[];
  review?: { botUsername: string; prompt: string };
  labels?: boolean;
  implement?: { prompt: string; checks?: string[] };
}

/** Writes a steward.config.ts into `dir` pointing at the given paths and returns its path. */
export const writeConfig = async (dir: string, p: ConfigPaths): Promise<string> => {
  const skills = p.skillsDir === undefined ? "" : `skillsDir: ${JSON.stringify(p.skillsDir)},`;
  const review = p.review === undefined ? "" : `review: ${JSON.stringify(p.review)},`;
  const labels = p.labels === true || p.implement !== undefined ? "labels: {}," : "";
  const implement =
    p.implement === undefined
      ? ""
      : `implement: ${JSON.stringify({ prompt: p.implement.prompt, checks: p.implement.checks ?? [], commitAuthor: { name: "Ticket Steward", email: "steward@example.com" } })},`;
  const slots = p.slots === undefined ? "" : `slots: ${JSON.stringify(p.slots)},`;
  const port = p.port === null ? "" : `port: ${p.port},`;
  const source = `
import { defineConfig } from "ticket-steward";
export default defineConfig({
  dataDir: ${JSON.stringify(p.dataDir)},
  brain: { kind: "claude-code", model: "claude-test", maxTurns: 5, timeoutMinutes: 1 },
  tracker: { kind: "linear", teams: ${JSON.stringify(p.teams ?? ["API"])}, gatewayIssues: "enrich", bugLabels: ["Bug"], ${labels} },
  codehost: { kind: "gitlab", baseUrl: "https://gitlab.example", project: "acme/repo" },
  workspace: {
    fetchUrl: ${JSON.stringify(p.fetchUrl)},
    baseBranch: "main",
    overlayDir: ${JSON.stringify(p.overlayDir)},
    ${skills}
    setup: [],
    setupTimeoutMinutes: 1,
    ${port}
    keepOnFailure: true,
  },
  retention: { keptWorktrees: 3, days: 30 },
  prompt: ${JSON.stringify(p.promptPath)},
  server: { port: ${p.serverPort}, publicUrl: "https://steward.example" },
  ${review}
  ${implement}
  ${slots}
});
`;
  const configPath = join(dir, "steward.config.ts");
  await writeFile(configPath, source);
  if (p.implement !== undefined) await writeFile(join(dir, ".env"), "GITLAB_PUSH_TOKEN=glpat-push-token-value\n");
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
