import { existsSync } from "node:fs";
import { copyFile, mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import type { Command } from "commander";
import { fail, println, type CliContext } from "./context.js";
import { defaultPromptPath, envExamplePath } from "./paths.js";

const CONFIG_TEMPLATE = `import { defineConfig } from "ticket-steward";

export default defineConfig({
  dataDir: "/var/lib/ticket-steward",
  brain: { kind: "claude-code", model: "claude-opus-5", maxTurns: 80, timeoutMinutes: 30 },
  // brain: { kind: "openai-agents", model: "gpt-5.5", maxTurns: 80, timeoutMinutes: 30 },
  tracker: { kind: "linear", teams: ["ENG"] },
  codehost: { kind: "gitlab", baseUrl: "https://gitlab.com", project: "org/repo" },
  // codehost: { kind: "github", owner: "org", repo: "repo" },
  workspace: {
    fetchUrl: "https://gitlab.com/org/repo.git", // token injected from MIRROR_TOKEN
    baseBranch: "main",
    overlayDir: "/var/lib/ticket-steward/overlay",
    skillsDir: "./skills",
    setup: ["pnpm install --frozen-lockfile --ignore-scripts"],
    setupTimeoutMinutes: 15,
    portRewrite: { from: 3000 },
    port: 4100,
    keepOnFailure: true,
  },
  retention: { keptWorktrees: 3, days: 30 },
  prompt: "./prompts/enrich.md",
  server: { port: 3020, publicUrl: "https://steward.example.com" },
});
`;

const SKILLS_README = `# Steward skills

Every directory in here is copied into \`<worktree>/.claude/skills/\` before the brain runs,
so steward-specific skills reach the agent without editing the target repository.

Skills that start the app must read the port from \`STEWARD_PORT\` and save screenshots
under the artifacts directory named in the prompt.
`;

interface Target {
  path: string;
  write: () => Promise<void>;
}

const targets = (dir: string): Target[] => [
  { path: join(dir, "steward.config.ts"), write: (): Promise<void> => writeFile(join(dir, "steward.config.ts"), CONFIG_TEMPLATE) },
  { path: join(dir, ".env.example"), write: (): Promise<void> => copyFile(envExamplePath, join(dir, ".env.example")) },
  { path: join(dir, "prompts", "enrich.md"), write: (): Promise<void> => copyFile(defaultPromptPath, join(dir, "prompts", "enrich.md")) },
  { path: join(dir, "skills", "README.md"), write: (): Promise<void> => writeFile(join(dir, "skills", "README.md"), SKILLS_README) },
];

export const registerInit = (program: Command, ctx: CliContext): void => {
  program
    .command("init")
    .description("write steward.config.ts, .env.example, prompts/enrich.md and skills/ into a directory")
    .argument("[dir]", "target directory", process.cwd())
    .action(async (dir: string) => {
      const files = targets(resolve(dir));
      const existing = files.filter((file) => existsSync(file.path));
      if (existing.length > 0) {
        return fail(ctx, ["refusing to overwrite existing files:", ...existing.map((file) => `  ${file.path}`)].join("\n"));
      }
      for (const file of files) {
        await mkdir(dirname(file.path), { recursive: true });
        await file.write();
        println(ctx, `wrote ${file.path}`);
      }
    });
};
