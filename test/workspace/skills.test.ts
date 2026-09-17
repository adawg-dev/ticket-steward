import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { copySkills } from "../../src/workspace/index.js";
import { removeDir, tmpDir } from "./helpers.js";

describe("copySkills", () => {
  let root: string;
  let worktreePath: string;

  beforeEach(async () => {
    vi.restoreAllMocks();
    root = await tmpDir();
    worktreePath = join(root, "worktree");
    await mkdir(worktreePath);
  });

  afterEach(async () => {
    await removeDir(root);
  });

  it("copies every skill file under <worktree>/.claude/skills", async () => {
    const skillsDir = join(root, "skills");
    await mkdir(join(skillsDir, "steward-verify", "scripts"), { recursive: true });
    await writeFile(join(skillsDir, "steward-verify", "SKILL.md"), "# verify\n");
    await writeFile(join(skillsDir, "steward-verify", "scripts", "run.sh"), "echo hi\n");

    const copied = await copySkills(skillsDir, worktreePath);

    expect(copied).toEqual(["steward-verify/SKILL.md", "steward-verify/scripts/run.sh"]);
    expect(await readFile(join(worktreePath, ".claude/skills/steward-verify/SKILL.md"), "utf8")).toBe("# verify\n");
    expect(await readFile(join(worktreePath, ".claude/skills/steward-verify/scripts/run.sh"), "utf8")).toBe("echo hi\n");
  });

  it("copies nothing when no skills dir is configured", async () => {
    expect(await copySkills(undefined, worktreePath)).toEqual([]);
  });

  it("copies nothing when the skills dir does not exist", async () => {
    expect(await copySkills(join(root, "missing"), worktreePath)).toEqual([]);
  });
});
