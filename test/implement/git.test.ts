import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { execa } from "execa";
import { BranchExistsError, commitWithHooks, installHookWrappers, pushCommit, remoteTicketBranches, restoreFromBundle, saveBundle, stageAndGuard } from "../../src/implement/git.js";
import { gitEnvRecord } from "../../src/workspace/git.js";
import { Mirror } from "../../src/workspace/mirror.js";
import { createWorktree, type Worktree } from "../../src/workspace/worktree.js";
import { commitFile, git, makeSourceRepo, removeDir, tmpDir } from "../workspace/helpers.js";

const AUTHOR = { name: "Ticket Steward", email: "steward@example.com" };
const TYPES = ["feature", "fix", "chore", "refactor"];

let root: string;
let source: string;
let base: string;
let mirror: Mirror;
let worktree: Worktree;

const env = (): Record<string, string> => ({ ...gitEnvRecord() });

beforeEach(async () => {
  root = await tmpDir();
  ({ repo: source } = await makeSourceRepo(root));
  await commitFile(source, ".gitignore", ".env\n");
  base = await commitFile(source, "src/a.ts", "export const a = 1;\n");
  mirror = await Mirror.init(join(root, "repo.git"), source);
  worktree = await createWorktree(mirror, join(root, "work"), "1-1", base);
});

afterEach(async () => {
  await removeDir(root);
});

describe("stageAndGuard", () => {
  it("stages the change and returns the paths", async () => {
    await writeFile(join(worktree.path, "src/a.ts"), "export const a = 2;\n");
    expect(await stageAndGuard({ worktreePath: worktree.path, overlayFiles: [".env"], skillsPrefix: ".claude/skills/", secretValues: [] })).toEqual({ ok: true, paths: ["src/a.ts"] });
  });

  it("refuses an empty change", async () => {
    const result = await stageAndGuard({ worktreePath: worktree.path, overlayFiles: [], skillsPrefix: ".claude/skills/", secretValues: [] });
    expect(result).toMatchObject({ ok: false, reason: "the agent reported the work as implemented but changed nothing" });
  });

  it("refuses an overlay file that is not gitignored and names it", async () => {
    await mkdir(join(worktree.path, "apps/web"), { recursive: true });
    await writeFile(join(worktree.path, "apps/web/.env.local"), "DB_PASSWORD=hunter2hunter2\n");
    await writeFile(join(worktree.path, "src/a.ts"), "export const a = 2;\n");
    const result = await stageAndGuard({ worktreePath: worktree.path, overlayFiles: ["apps/web/.env.local"], skillsPrefix: ".claude/skills/", secretValues: [] });
    expect(result).toEqual({ ok: false, reason: "the change would commit files the steward copied in", detail: "apps/web/.env.local" });
  });

  it("refuses copied skills", async () => {
    await mkdir(join(worktree.path, ".claude/skills/verify"), { recursive: true });
    await writeFile(join(worktree.path, ".claude/skills/verify/SKILL.md"), "x\n");
    const result = await stageAndGuard({ worktreePath: worktree.path, overlayFiles: [], skillsPrefix: ".claude/skills/", secretValues: [] });
    expect(result).toMatchObject({ ok: false, detail: ".claude/skills/verify/SKILL.md" });
  });

  it("refuses a diff containing a secret value and names the file, not the value", async () => {
    await writeFile(join(worktree.path, "src/a.ts"), 'export const key = "sk-live-abcdef123456";\n');
    const result = await stageAndGuard({ worktreePath: worktree.path, overlayFiles: [], skillsPrefix: ".claude/skills/", secretValues: ["sk-live-abcdef123456"] });
    expect(result).toEqual({ ok: false, reason: "the change contains a secret value from the overlay", detail: "src/a.ts" });
  });
});

describe("commitWithHooks", () => {
  const message = "API-1: Keep the last chunk\n\nFlush before close.";

  it("commits with the configured author on top of the base", async () => {
    await writeFile(join(worktree.path, "src/a.ts"), "export const a = 2;\n");
    await stageAndGuard({ worktreePath: worktree.path, overlayFiles: [], skillsPrefix: ".claude/skills/", secretValues: [] });
    const hooksDir = join(root, "hooks");
    await installHookWrappers(worktree.path, hooksDir);
    const result = await commitWithHooks({ worktreePath: worktree.path, hooksDir, messagePath: join(root, "MSG"), message, author: AUTHOR, env: env() });
    expect(result.ok).toBe(true);
    const sha = result.ok ? result.sha : "";
    expect(await git(worktree.path, ["log", "-1", "--format=%an <%ae>%n%P%n%B", sha])).toBe(`Ticket Steward <steward@example.com>\n${base}\n${message}`);
  });

  it("runs the repo's husky pre-commit hook and reports its output on failure", async () => {
    await mkdir(join(worktree.path, ".husky"), { recursive: true });
    await writeFile(join(worktree.path, ".husky/pre-commit"), 'echo "lint failed: no-unused-vars"\nexit 1\n');
    await writeFile(join(worktree.path, "src/a.ts"), "export const a = 2;\n");
    await stageAndGuard({ worktreePath: worktree.path, overlayFiles: [], skillsPrefix: ".claude/skills/", secretValues: [] });
    const hooksDir = join(root, "hooks");
    expect(await installHookWrappers(worktree.path, hooksDir)).toEqual(["pre-commit"]);
    const result = await commitWithHooks({ worktreePath: worktree.path, hooksDir, messagePath: join(root, "MSG"), message, author: AUTHOR, env: env() });
    expect(result.ok).toBe(false);
    expect(result.ok ? "" : result.output).toContain("lint failed: no-unused-vars");
  });

  it("does not change the shared git config", async () => {
    await writeFile(join(worktree.path, "src/a.ts"), "export const a = 2;\n");
    await stageAndGuard({ worktreePath: worktree.path, overlayFiles: [], skillsPrefix: ".claude/skills/", secretValues: [] });
    const before = await readFile(join(mirror.path, "config"), "utf8");
    await installHookWrappers(worktree.path, join(root, "hooks"));
    await commitWithHooks({ worktreePath: worktree.path, hooksDir: join(root, "hooks"), messagePath: join(root, "MSG"), message, author: AUTHOR, env: env() });
    expect(await readFile(join(mirror.path, "config"), "utf8")).toBe(before);
  });
});

describe("push", () => {
  const commitChange = async (): Promise<string> => {
    await writeFile(join(worktree.path, "src/a.ts"), "export const a = 2;\n");
    await stageAndGuard({ worktreePath: worktree.path, overlayFiles: [], skillsPrefix: ".claude/skills/", secretValues: [] });
    await installHookWrappers(worktree.path, join(root, "hooks"));
    const result = await commitWithHooks({ worktreePath: worktree.path, hooksDir: join(root, "hooks"), messagePath: join(root, "MSG"), message: "API-1: x", author: AUTHOR, env: env() });
    if (!result.ok) throw new Error(result.output);
    return result.sha;
  };
  const remote = () => ({ url: source, env: {} });

  it("pushes the commit to a new branch", async () => {
    const sha = await commitChange();
    await pushCommit({ cwd: worktree.path, remote: remote(), sha, baseSha: base, branch: "fix/API-1-keep-last-chunk", identifier: "API-1", branchTypes: TYPES });
    expect(await git(source, ["rev-parse", "refs/heads/fix/API-1-keep-last-chunk"])).toBe(sha);
  });

  it("refuses a branch outside the pattern", async () => {
    const sha = await commitChange();
    await expect(pushCommit({ cwd: worktree.path, remote: remote(), sha, baseSha: base, branch: "main", identifier: "API-1", branchTypes: TYPES })).rejects.toThrow("refusing to push to refs/heads/main");
  });

  it("refuses a commit that is not directly on the base", async () => {
    const sha = await commitChange();
    await expect(pushCommit({ cwd: worktree.path, remote: remote(), sha, baseSha: "b".repeat(40), branch: "fix/API-1-x", identifier: "API-1", branchTypes: TYPES })).rejects.toThrow("is not a single commit on top of");
  });

  it("refuses when any branch already carries the ticket", async () => {
    await git(source, ["branch", "feature/API-1-by-hand", base]);
    const sha = await commitChange();
    expect(await remoteTicketBranches(remote(), worktree.path, "API-1")).toEqual([{ ref: "refs/heads/feature/API-1-by-hand", sha: base }]);
    await expect(pushCommit({ cwd: worktree.path, remote: remote(), sha, baseSha: base, branch: "fix/API-1-x", identifier: "API-1", branchTypes: TYPES })).rejects.toBeInstanceOf(BranchExistsError);
  });

  it("restores a commit from its bundle into another repo and pushes it from there", async () => {
    const sha = await commitChange();
    const bundle = join(root, "implement.bundle");
    await saveBundle(worktree.path, base, bundle);
    const other = join(root, "other.git");
    await execa("git", ["clone", "--quiet", "--bare", source, other], { env: gitEnvRecord(), extendEnv: false });
    await restoreFromBundle(other, bundle, sha);
    await pushCommit({ cwd: other, remote: remote(), sha, baseSha: base, branch: "fix/API-1-x", identifier: "API-1", branchTypes: TYPES });
    expect(await git(source, ["rev-parse", "refs/heads/fix/API-1-x"])).toBe(sha);
  });
});
