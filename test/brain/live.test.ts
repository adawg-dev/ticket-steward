import { execFile } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { buildBrainEnv } from "../../src/brain/env.js";
import { runBrainDetached } from "../../src/brain/spawn.js";
import type { BrainInput } from "../../src/brain/types.js";
import type { BrainConfig } from "../../src/config/schema.js";
import { Redactor } from "../../src/core/redact.js";
import { BrainResultSchema } from "../../src/core/result.js";

const exec = promisify(execFile);
const live = process.env.STEWARD_LIVE_BRAIN === "1";

const claudeCode: BrainConfig = { kind: "claude-code", model: process.env.STEWARD_LIVE_CLAUDE_MODEL ?? "claude-sonnet-4-5", maxTurns: 12, timeoutMinutes: 5 };
const openaiAgents: BrainConfig = { kind: "openai-agents", model: process.env.STEWARD_LIVE_OPENAI_MODEL ?? "gpt-5", maxTurns: 12, timeoutMinutes: 5 };

const PROMPT = `You are enriching a ticket titled "Greeting is lowercase" for a tiny repository.
The ticket says: "hello.ts prints a lowercase greeting; it should be capitalized."
Look at the repository in the working directory, locate the relevant file, and return the structured result.
Set template.matched to null, template.conforms to true, template.missing to [], attachments to [], and reference files as relative/path.ts:line.`;

let dir: string;

const secretsFromEnv = () => ({
  ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
  CLAUDE_CODE_OAUTH_TOKEN: process.env.CLAUDE_CODE_OAUTH_TOKEN,
  OPENAI_API_KEY: process.env.OPENAI_API_KEY,
  OPENAI_BASE_URL: process.env.OPENAI_BASE_URL,
});

const liveInput = (brain: BrainConfig): BrainInput => ({
  workspacePath: join(dir, "repo"),
  artifactsDir: join(dir, "artifacts"),
  transcriptPath: join(dir, "attempt-1.jsonl"),
  prompt: PROMPT,
  env: buildBrainEnv(secretsFromEnv(), brain, 4100),
  timeoutMs: brain.timeoutMinutes * 60_000,
  maxTurns: brain.maxTurns,
  model: brain.model,
  mcpServers: {},
  denyPaths: [],
});

describe.skipIf(!live)("live brain contract", () => {
  beforeEach(async () => {
    vi.restoreAllMocks();
    dir = await mkdtemp(join(tmpdir(), "steward-live-brain-"));
    const repo = join(dir, "repo");
    await mkdir(repo);
    await mkdir(join(dir, "artifacts"));
    await writeFile(join(repo, "hello.ts"), 'export const greet = (): string => "hello world";\n');
    await exec("git", ["init", "-q"], { cwd: repo });
    await exec("git", ["-c", "user.name=t", "-c", "user.email=t@t", "add", "."], { cwd: repo });
    await exec("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "init"], { cwd: repo });
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("claude-code returns output that validates as BrainResult", async () => {
    const run = await runBrainDetached(claudeCode, liveInput(claudeCode), new Redactor([]));
    expect(run.ok).toBe(true);
    expect(BrainResultSchema.safeParse(run.output).success).toBe(true);
  }, 360_000);

  it("openai-agents returns output that validates as BrainResult", async () => {
    const run = await runBrainDetached(openaiAgents, liveInput(openaiAgents), new Redactor([]));
    expect(run.ok).toBe(true);
    expect(BrainResultSchema.safeParse(run.output).success).toBe(true);
  }, 360_000);
});
