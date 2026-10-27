import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { PLAYWRIGHT_TOOLS, createOpenAiAgentsBrain, modelSettingsFor, skillsText } from "../../src/brain/openaiAgents.js";
import type { BrainInput } from "../../src/brain/types.js";
import { removeDir, tmpDir } from "../workspace/helpers.js";

describe("modelSettingsFor", () => {
  it("sends the configured reasoning effort", () => {
    expect(modelSettingsFor({ reasoningEffort: "high" })).toEqual({ reasoning: { effort: "high" } });
  });

  it("leaves the SDK's per-model default alone when none is configured", () => {
    expect(modelSettingsFor({})).toEqual({});
  });
});

describe("skillsText", () => {
  let root: string;

  beforeEach(async () => {
    root = await tmpDir();
    for (const name of ["steward-user-app-verify", "preprod-kubectl"]) {
      await mkdir(join(root, ".claude", "skills", name), { recursive: true });
      await writeFile(join(root, ".claude", "skills", name, "SKILL.md"), `body of ${name}`);
    }
  });

  afterEach(async () => {
    await removeDir(root);
  });

  it("inlines only the named skills", async () => {
    const text = await skillsText(root, ["steward-user-app-verify"]);

    expect(text).toContain("## Skill: steward-user-app-verify\n\nbody of steward-user-app-verify");
    expect(text).not.toContain("preprod-kubectl");
  });

  it("inlines every skill when no names are given", async () => {
    const text = await skillsText(root, undefined);

    expect(text).toContain("## Skill: preprod-kubectl");
    expect(text).toContain("## Skill: steward-user-app-verify");
  });
});

describe("PLAYWRIGHT_TOOLS", () => {
  it("leaves out the unsafe and rarely useful browser tools", () => {
    expect(PLAYWRIGHT_TOOLS).toContain("browser_navigate");
    expect(PLAYWRIGHT_TOOLS).not.toContain("browser_run_code_unsafe");
    expect(PLAYWRIGHT_TOOLS).not.toContain("browser_file_upload");
  });
});

describe("openai-agents brain", () => {
  it("refuses to resume a session", async () => {
    const input: BrainInput = {
      workspacePath: "/data/work/42-1",
      artifactsDir: "/data/jobs/42/artifacts",
      transcriptPath: "/data/jobs/42/attempt-1.jsonl",
      prompt: "fix",
      env: {},
      timeoutMs: 10_000,
      maxTurns: 12,
      model: "gpt-test",
      mcpServers: {},
      denyPaths: [],
      output: "fix",
      resumeSessionId: "s0",
    };

    const run = await createOpenAiAgentsBrain().run(input, () => undefined);

    expect(run).toEqual({ ok: false, output: undefined, error: "openai-agents cannot resume a session" });
  });
});
