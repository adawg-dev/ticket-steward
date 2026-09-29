import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { PLAYWRIGHT_TOOLS, modelSettingsFor, skillsText } from "../../src/brain/openaiAgents.js";
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
