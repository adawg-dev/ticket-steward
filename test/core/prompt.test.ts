import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { renderChatPrompt, type ChatPromptInput } from "../../src/chat/run.js";
import { readRepoPartial } from "../../src/core/prompt.js";
import { renderFixPrompt, type FixPromptInput } from "../../src/greptile/prompt.js";
import { renderImplementPrompt, type ImplementPromptVars } from "../../src/implement/prompt.js";

const implementVars: ImplementPromptVars = {
  identifier: "API-1", teamKey: "API", teamName: "API", ticket: "# API-1: Adapter drops the last chunk", workspacePath: "/work/1-1",
  baseBranch: "dev", sha: "a".repeat(40), artifactsDir: "/jobs/1/artifacts", stewardPort: 4100, hasBrief: false, brief: "",
  branchTypes: "feature, fix, chore, refactor", hasChecks: false, checks: "", reply: "",
};
const fixInput: FixPromptInput = {
  identifier: "ENG-1", round: 2, score: 3, summary: "Confidence Score: 3/5", comments: [], ciFailures: [], personCommits: [],
  decisions: [], workspacePath: "/ws", headSha: "deadbeef", stewardPort: 4321, artifactsDir: "/art", checks: "", hasChecks: false,
};
const chatInput: ChatPromptInput = {
  identifier: "API-1", author: "ada", message: "why?", mrUrl: "https://gl/mr/1", workspacePath: "/ws", headSha: "deadbeef",
  stewardPort: 4100, artifactsDir: "/art", canPush: true, branch: "fix/API-1-x", checks: "", hasChecks: false, decisions: [],
};

const REPO = "## Working in kickoff\n\n- Run `pnpm add <pkg>@<version> --filter <name>` & <b>raw</b>.\n";

const prompts: Array<{ name: string; render: (repo?: string) => Promise<string> }> = [
  { name: "implement", render: async (repo) => renderImplementPrompt(await readFile("prompts/implement.md", "utf8"), implementVars, repo) },
  { name: "fix", render: async (repo) => renderFixPrompt(await readFile("prompts/fix.md", "utf8"), fixInput, repo) },
  { name: "chat", render: async (repo) => renderChatPrompt(await readFile("prompts/chat.md", "utf8"), chatInput, repo) },
];

describe.each(prompts)("the $name prompt", ({ render }) => {
  it("renders the repo's section after the codebase graph, before the rules, unescaped", async () => {
    const out = await render(REPO);
    expect(out).toContain("## Working in kickoff\n\n- Run `pnpm add <pkg>@<version> --filter <name>` & <b>raw</b>.");
    expect(out.indexOf("## Codebase graph")).toBeLessThan(out.indexOf("## Working in kickoff"));
    expect(out.indexOf("## Working in kickoff")).toBeLessThan(out.indexOf("## Rules"));
  });

  it("renders nothing for a repo without one, and no partial tag", async () => {
    for (const out of [await render(), await render("")]) {
      expect(out).not.toContain("{{");
      expect(out).not.toContain("Working in");
      expect(out).toMatch(/do not retry it\.\n\n## Rules/);
    }
  });

  it("carries the shared rules: credentials, long-running processes and honest results", async () => {
    const out = await render();
    expect(out).toContain("Credentials are not yours to find.");
    expect(out).toContain("starts with `STEWARD_PH_` is a placeholder the steward's proxy swaps for the real value");
    expect(out).toContain("Start long-running processes (the app, a dev server, a watcher) only when a check needs them");
    expect(out).toContain("- Report what happened, not what you hoped:");
  });

  it("asks for screenshots of a visible change and a video of a flow, saved in the artifacts dir and listed in media", async () => {
    const out = await render();
    expect(out).toContain("## Show the change");
    expect(out).toContain("`browser_start_video` before the first step, `browser_video_chapter`");
    expect(out).toContain("`browser_stop_video` after the last");
    expect(out).toMatch(/Playwright saves both under `\/(jobs\/1\/)?art(ifacts)?`/);
    expect(out).toContain("At most 10 files of up to 25 MB each");
    expect(out).toContain("- `media`:");
    expect(out.indexOf("## Show the change")).toBeLessThan(out.indexOf("## Result"));
  });
});

describe("readRepoPartial", () => {
  it("reads prompts/repo.md beside the config, and is empty when there is none", async () => {
    const dir = await mkdtemp(join(tmpdir(), "steward-prompt-"));
    try {
      const configPath = join(dir, "steward.config.ts");
      expect(await readRepoPartial(configPath)).toBe("");
      await mkdir(join(dir, "prompts"));
      await writeFile(join(dir, "prompts", "repo.md"), REPO);
      expect(await readRepoPartial(configPath)).toBe(REPO);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("ships the same repo section in the kickoff example and the steward's prompts", async () => {
    expect(await readRepoPartial("examples/kickoff/steward.config.ts")).toBe(await readFile("prompts/repo.md", "utf8"));
    expect(await readFile("prompts/repo.md", "utf8")).toMatch(/^## Working in kickoff\n/);
  });
});
