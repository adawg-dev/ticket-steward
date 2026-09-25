import { mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { captureReproFiles, isBugTicket, normalizeRepro, renderReproMarkdown, restoreReproFiles, REPRO_MAX_BYTES } from "../../src/core/repro.js";
import type { BrainResult } from "../../src/core/result.js";
import { removeDir, tmpDir } from "../workspace/helpers.js";

const result: BrainResult = {
  template: { matched: null, conforms: true, missing: [] },
  summary: "s",
  enrichment: "e",
  attachments: [],
  confidence: "high",
  repro: { status: "reproduced", method: "http", command: "curl -s localhost:4100/v1/x", steps: [], files: [], expected: "200", observed: "500" },
};

describe("isBugTicket", () => {
  it("matches a configured label ignoring case and whitespace", () => {
    expect(isBugTicket(["bug "], ["Bug"])).toBe(true);
    expect(isBugTicket(["Feature", "Defect"], ["Bug", "defect"])).toBe(true);
  });

  it("is false without a matching label", () => {
    expect(isBugTicket(["Feature"], ["Bug"])).toBe(false);
    expect(isBugTicket([], ["Bug"])).toBe(false);
  });
});

describe("normalizeRepro", () => {
  it("keeps the recipe for bugs", () => {
    expect(normalizeRepro(result, true).repro).toEqual(result.repro);
  });

  it("drops any recipe for non-bugs", () => {
    expect(normalizeRepro(result, false).repro).toBeNull();
  });
});

describe("captureReproFiles", () => {
  let root: string;
  let worktree: string;
  let dest: string;

  beforeEach(async () => {
    root = await tmpDir();
    worktree = join(root, "wt");
    dest = join(root, "repros", "7");
    await mkdir(join(worktree, "apps/api/test"), { recursive: true });
    await writeFile(join(worktree, "apps/api/test/repro.test.ts"), "it('repro', () => {});\n");
  });

  afterEach(() => removeDir(root));

  it("copies listed files under the destination", async () => {
    const { saved, notes } = await captureReproFiles(worktree, ["apps/api/test/repro.test.ts"], dest);
    expect(saved).toEqual(["apps/api/test/repro.test.ts"]);
    expect(notes).toEqual([]);
    expect(await readFile(join(dest, "apps/api/test/repro.test.ts"), "utf8")).toContain("repro");
  });

  it("refuses paths outside the worktree", async () => {
    await writeFile(join(root, "secret.txt"), "nope");
    await symlink(join(root, "secret.txt"), join(worktree, "link.txt"));
    const { saved, notes } = await captureReproFiles(worktree, ["../secret.txt", "/etc/hostname", "link.txt", "apps/api/test/repro.test.ts"], dest);
    expect(saved).toEqual(["apps/api/test/repro.test.ts"]);
    expect(notes).toEqual([
      "Recipe file `../secret.txt` not saved: the path must stay inside the workspace.",
      "Recipe file `/etc/hostname` not saved: the path must stay inside the workspace.",
      "Recipe file `link.txt` not saved: the path must stay inside the workspace.",
    ]);
  });

  it("refuses missing, oversized and surplus files", async () => {
    await writeFile(join(worktree, "big.bin"), Buffer.alloc(REPRO_MAX_BYTES + 1));
    const many = Array.from({ length: 21 }, (_, i) => `f${i}.txt`);
    for (const file of many) await writeFile(join(worktree, file), "x");
    const { saved, notes } = await captureReproFiles(worktree, ["missing.ts", "big.bin", ...many], dest);
    expect(saved).toHaveLength(20);
    expect(notes).toEqual([
      "Recipe file `missing.ts` not saved: file not found.",
      "Recipe file `big.bin` not saved: larger than 1 MB.",
      "Recipe file `f20.txt` not saved: more than 20 files.",
    ]);
  });
});

describe("restoreReproFiles", () => {
  it("puts saved files back at their workspace paths", async () => {
    const root = await tmpDir();
    const filesDir = join(root, "saved");
    await mkdir(join(filesDir, "apps/api/test"), { recursive: true });
    await writeFile(join(filesDir, "apps/api/test/repro.test.ts"), "x");
    const worktree = join(root, "wt");
    await mkdir(worktree);
    expect(await restoreReproFiles(filesDir, ["apps/api/test/repro.test.ts", "../escape.ts"], worktree)).toEqual(["apps/api/test/repro.test.ts"]);
    expect(await readFile(join(worktree, "apps/api/test/repro.test.ts"), "utf8")).toBe("x");
    await removeDir(root);
  });
});

describe("renderReproMarkdown", () => {
  it("renders the recipe as a readable block", () => {
    const text = renderReproMarkdown({
      status: "reproduced",
      method: "test",
      command: "pnpm vitest run a.test.ts",
      steps: ["Start nothing", "Run the test"],
      files: ["a.test.ts"],
      expected: "passes",
      observed: "fails with 500",
    });
    expect(text).toBe(
      [
        "### Reproduction",
        "",
        "**Status:** reproduced · **Method:** test",
        "",
        "**Command** (from the workspace root):",
        "",
        "```sh",
        "pnpm vitest run a.test.ts",
        "```",
        "",
        "**Steps:**",
        "",
        "1. Start nothing",
        "2. Run the test",
        "",
        "**Expected:** passes",
        "",
        "**Observed:** fails with 500",
        "",
        "**Recipe files:** `a.test.ts`",
      ].join("\n"),
    );
  });

  it("switches to a tilde fence when the command contains backticks", () => {
    expect(renderReproMarkdown({ status: "not_reproduced", method: "script", command: "echo ```", steps: [], files: [], expected: "a", observed: "b" })).toContain("~~~sh\necho ```\n~~~");
  });
});
