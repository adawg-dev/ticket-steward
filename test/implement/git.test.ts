import { existsSync } from "node:fs";
import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { BranchExistsError, type PushMode, bundleBase, commitWithHooks, guardCommit, installHookWrappers, pushCommit, remoteTicketBranches, saveBundle, stageAndGuard } from "../../src/implement/git.js";
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
    await writeFile(join(worktree.path, ".env"), "TOKEN=abc123abc123\n");
    await writeFile(join(worktree.path, "src/a.ts"), "export const a = 2;\n");
    expect(await stageAndGuard({ worktreePath: worktree.path, stewardFiles: [".env"], secretValues: [] })).toEqual({ ok: true, paths: ["src/a.ts"] });
  });

  it("refuses an empty change", async () => {
    const result = await stageAndGuard({ worktreePath: worktree.path, stewardFiles: [], secretValues: [] });
    expect(result).toMatchObject({ ok: false, reason: "the agent reported the work as implemented but changed nothing" });
  });

  it("leaves out an overlay file that is not gitignored", async () => {
    await mkdir(join(worktree.path, "apps/web"), { recursive: true });
    await writeFile(join(worktree.path, "apps/web/.env.local"), "DB_PASSWORD=hunter2hunter2\n");
    await writeFile(join(worktree.path, "src/a.ts"), "export const a = 2;\n");
    const result = await stageAndGuard({ worktreePath: worktree.path, stewardFiles: ["apps/web/.env.local"], secretValues: [] });
    expect(result).toEqual({ ok: true, paths: ["src/a.ts"] });
  });

  it("leaves out copied skills the repo does not gitignore", async () => {
    await mkdir(join(worktree.path, ".claude/skills/verify"), { recursive: true });
    await writeFile(join(worktree.path, ".claude/skills/verify/SKILL.md"), "x\n");
    await writeFile(join(worktree.path, ".claude/skills/README.md"), "x\n");
    await writeFile(join(worktree.path, "src/a.ts"), "export const a = 2;\n");
    const result = await stageAndGuard({ worktreePath: worktree.path, stewardFiles: [".claude/skills/verify/SKILL.md", ".claude/skills/README.md"], secretValues: [] });
    expect(result).toEqual({ ok: true, paths: ["src/a.ts"] });
  });

  it("keeps a tracked file's HEAD content when a steward copy overwrote it", async () => {
    const head = await commitFile(source, ".claude/skills/README.md", "repo readme\n");
    await mirror.fetch();
    const tracked = await createWorktree(mirror, join(root, "work"), "1-2", head);
    await writeFile(join(tracked.path, ".claude/skills/README.md"), "steward readme\n");
    await writeFile(join(tracked.path, "src/a.ts"), "export const a = 2;\n");
    const result = await stageAndGuard({ worktreePath: tracked.path, stewardFiles: [".claude/skills/README.md"], secretValues: [] });
    expect(result).toEqual({ ok: true, paths: ["src/a.ts"] });
  });

  it("stages the agent's edit to a skill the repo itself tracks", async () => {
    const head = await commitFile(source, ".claude/skills/own/SKILL.md", "v1\n");
    await mirror.fetch();
    const tracked = await createWorktree(mirror, join(root, "work"), "1-3", head);
    await writeFile(join(tracked.path, ".claude/skills/own/SKILL.md"), "v2\n");
    const result = await stageAndGuard({ worktreePath: tracked.path, stewardFiles: [".claude/skills/README.md"], secretValues: [] });
    expect(result).toEqual({ ok: true, paths: [".claude/skills/own/SKILL.md"] });
  });

  it("refuses when only steward copies changed", async () => {
    await writeFile(join(worktree.path, "notes.md"), "x\n");
    const result = await stageAndGuard({ worktreePath: worktree.path, stewardFiles: ["notes.md"], secretValues: [] });
    expect(result).toMatchObject({ ok: false, reason: "the agent reported the work as implemented but changed nothing" });
  });

  it("finds a secret in a binary file", async () => {
    await writeFile(join(worktree.path, "blob.bin"), Buffer.from("\0sk-live-abcdef123456\0"));
    const result = await stageAndGuard({ worktreePath: worktree.path, stewardFiles: [], secretValues: ["sk-live-abcdef123456"] });
    expect(result).toEqual({ ok: false, reason: "the change contains a secret value", detail: "blob.bin" });
  });

  it("finds a secret when .gitattributes marks the file -diff", async () => {
    await writeFile(join(worktree.path, ".gitattributes"), "*.ts -diff\n");
    await writeFile(join(worktree.path, "src/a.ts"), 'export const key = "sk-live-abcdef123456";\n');
    const result = await stageAndGuard({ worktreePath: worktree.path, stewardFiles: [], secretValues: ["sk-live-abcdef123456"] });
    expect(result).toEqual({ ok: false, reason: "the change contains a secret value", detail: "src/a.ts" });
  });

  it("refuses a diff containing a secret value and names the file, not the value", async () => {
    await writeFile(join(worktree.path, "src/a.ts"), 'export const key = "sk-live-abcdef123456";\n');
    const result = await stageAndGuard({ worktreePath: worktree.path, stewardFiles: [], secretValues: ["sk-live-abcdef123456"] });
    expect(result).toEqual({ ok: false, reason: "the change contains a secret value", detail: "src/a.ts" });
  });

  it("finds a secret on an added line that starts with ++", async () => {
    await writeFile(join(worktree.path, "src/a.ts"), "export const a = 1;\n++sk-live-abcdef123456\n");
    const result = await stageAndGuard({ worktreePath: worktree.path, stewardFiles: [], secretValues: ["sk-live-abcdef123456"] });
    expect(result).toEqual({ ok: false, reason: "the change contains a secret value", detail: "src/a.ts" });
  });

  it("finds a secret in a file whose name is pathspec magic and names the file", async () => {
    await writeFile(join(worktree.path, ":(glob)zz"), "sk-live-abcdef123456\n");
    const result = await stageAndGuard({ worktreePath: worktree.path, stewardFiles: [], secretValues: ["sk-live-abcdef123456"] });
    expect(result).toEqual({ ok: false, reason: "the change contains a secret value", detail: ":(glob)zz" });
  });

  it("names a file with a quoted name", async () => {
    await writeFile(join(worktree.path, 'tab\t"q"\u00e9.txt'), "sk-live-abcdef123456\n");
    await writeFile(join(worktree.path, "src/a.ts"), "export const a = 2;\n");
    const result = await stageAndGuard({ worktreePath: worktree.path, stewardFiles: [], secretValues: ["sk-live-abcdef123456"] });
    expect(result).toEqual({ ok: false, reason: "the change contains a secret value", detail: 'tab\t"q"\u00e9.txt' });
  });

  it("hands back a change too large to scan instead of scanning a truncated diff", async () => {
    await writeFile(join(worktree.path, "src/big.txt"), `${"x".repeat(80)}\n`.repeat(100) + "sk-live-abcdef123456\n");
    const result = await stageAndGuard({ worktreePath: worktree.path, stewardFiles: [], secretValues: ["sk-live-abcdef123456"], maxDiffBytes: 1024 });
    expect(result).toEqual({ ok: false, reason: "the change is too large to scan for secrets", detail: "src/big.txt" });
  });
});

describe("commitWithHooks", () => {
  const message = "API-1: Keep the last chunk\n\nFlush before close.";

  it("commits with the configured author on top of the base", async () => {
    await writeFile(join(worktree.path, "src/a.ts"), "export const a = 2;\n");
    await stageAndGuard({ worktreePath: worktree.path, stewardFiles: [], secretValues: [] });
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
    await stageAndGuard({ worktreePath: worktree.path, stewardFiles: [], secretValues: [] });
    const hooksDir = join(root, "hooks");
    expect(await installHookWrappers(worktree.path, hooksDir)).toEqual(["pre-commit"]);
    const result = await commitWithHooks({ worktreePath: worktree.path, hooksDir, messagePath: join(root, "MSG"), message, author: AUTHOR, env: env() });
    expect(result.ok).toBe(false);
    expect(result.ok ? "" : result.output).toContain("lint failed: no-unused-vars");
  });

  it("does not change the shared git config", async () => {
    await writeFile(join(worktree.path, "src/a.ts"), "export const a = 2;\n");
    await stageAndGuard({ worktreePath: worktree.path, stewardFiles: [], secretValues: [] });
    const before = await readFile(join(mirror.path, "config"), "utf8");
    await installHookWrappers(worktree.path, join(root, "hooks"));
    await commitWithHooks({ worktreePath: worktree.path, hooksDir: join(root, "hooks"), messagePath: join(root, "MSG"), message, author: AUTHOR, env: env() });
    expect(await readFile(join(mirror.path, "config"), "utf8")).toBe(before);
  });
});

describe("guardCommit", () => {
  const guard = { stewardFiles: [".env"], secretValues: ["sk-live-abcdef123456"] };
  const commitAll = async (): Promise<string> => {
    await git(worktree.path, ["-c", "user.name=t", "-c", "user.email=t@x", "commit", "--quiet", "--no-gpg-sign", "-m", "c"]);
    return git(worktree.path, ["rev-parse", "HEAD"]);
  };

  it("passes a clean single commit on the base", async () => {
    await writeFile(join(worktree.path, "src/a.ts"), "export const a = 2;\n");
    await stageAndGuard({ worktreePath: worktree.path, ...guard });
    const sha = await commitAll();
    expect(await guardCommit({ worktreePath: worktree.path, baseSha: base, sha, ...guard })).toEqual({ ok: true, paths: ["src/a.ts"] });
  });

  it("refuses a committed overlay file and a committed secret", async () => {
    await writeFile(join(worktree.path, ".env"), "TOKEN=abc123abc123\n");
    await writeFile(join(worktree.path, "src/a.ts"), 'export const key = "sk-live-abcdef123456";\n');
    await git(worktree.path, ["add", "-f", ".env", "src/a.ts"]);
    const sha = await commitAll();
    expect(await guardCommit({ worktreePath: worktree.path, baseSha: base, sha, ...guard })).toEqual({ ok: false, reason: "the change would commit files the steward copied in", detail: ".env" });
    await git(worktree.path, ["rm", "--cached", "--quiet", ".env"]);
    await git(worktree.path, ["-c", "user.name=t", "-c", "user.email=t@x", "commit", "--quiet", "--amend", "--no-gpg-sign", "-m", "c"]);
    const amended = await git(worktree.path, ["rev-parse", "HEAD"]);
    expect(await guardCommit({ worktreePath: worktree.path, baseSha: base, sha: amended, ...guard })).toEqual({ ok: false, reason: "the change contains a secret value", detail: "src/a.ts" });
  });

  it("refuses a commit whose message carries a secret value, never naming the value", async () => {
    await writeFile(join(worktree.path, "src/a.ts"), "export const a = 2;\n");
    await stageAndGuard({ worktreePath: worktree.path, ...guard });
    await git(worktree.path, ["-c", "user.name=t", "-c", "user.email=t@x", "commit", "--quiet", "--no-gpg-sign", "-m", "c\n\nkey: sk-live-abcdef123456"]);
    const sha = await git(worktree.path, ["rev-parse", "HEAD"]);
    expect(await guardCommit({ worktreePath: worktree.path, baseSha: base, sha, ...guard })).toEqual({ ok: false, reason: "the commit message contains a secret value", detail: "commit message" });
  });

  it("refuses, rather than passes, when the secret scan's diff fails", async () => {
    await writeFile(join(worktree.path, "src/a.ts"), "export const a = 2;\n");
    await stageAndGuard({ worktreePath: worktree.path, ...guard });
    const sha = await commitAll();
    // The tree diff still lists the path, but the blob is gone, so the per-file content diff exits non-zero.
    const blob = await git(worktree.path, ["rev-parse", `${sha}:src/a.ts`]);
    await rm(await git(worktree.path, ["rev-parse", "--path-format=absolute", "--git-path", `objects/${blob.slice(0, 2)}/${blob.slice(2)}`]));
    expect(await guardCommit({ worktreePath: worktree.path, baseSha: base, sha, ...guard })).toEqual({ ok: false, reason: "the change could not be scanned for secrets", detail: "src/a.ts" });
  });

  it("refuses a commit whose parent is not the base", async () => {
    await writeFile(join(worktree.path, "src/a.ts"), "export const a = 2;\n");
    await stageAndGuard({ worktreePath: worktree.path, ...guard });
    await commitAll();
    await writeFile(join(worktree.path, "src/a.ts"), "export const a = 3;\n");
    await git(worktree.path, ["add", "src/a.ts"]);
    const sha = await commitAll();
    expect(await guardCommit({ worktreePath: worktree.path, baseSha: base, sha, ...guard })).toMatchObject({ ok: false, reason: "the commit is not a single commit on top of the base" });
  });
});

describe("installHookWrappers", () => {
  it("skips post-commit and clears wrappers left by an earlier attempt", async () => {
    const hooksDir = join(root, "hooks");
    await mkdir(hooksDir, { recursive: true });
    await writeFile(join(hooksDir, "commit-msg"), "#!/bin/sh\nexit 0\n");
    await mkdir(join(worktree.path, ".husky"), { recursive: true });
    await writeFile(join(worktree.path, ".husky/pre-commit"), "exit 0\n");
    await writeFile(join(worktree.path, ".husky/post-commit"), "git commit --amend -a --no-edit\n");

    expect(await installHookWrappers(worktree.path, hooksDir)).toEqual(["pre-commit"]);
    expect(existsSync(join(hooksDir, "commit-msg"))).toBe(false);
    expect(existsSync(join(hooksDir, "post-commit"))).toBe(false);
  });
});

describe("push", () => {
  const commitChange = async (): Promise<string> => {
    await writeFile(join(worktree.path, "src/a.ts"), "export const a = 2;\n");
    await stageAndGuard({ worktreePath: worktree.path, stewardFiles: [], secretValues: [] });
    await installHookWrappers(worktree.path, join(root, "hooks"));
    const result = await commitWithHooks({ worktreePath: worktree.path, hooksDir: join(root, "hooks"), messagePath: join(root, "MSG"), message: "API-1: x", author: AUTHOR, env: env() });
    if (!result.ok) throw new Error(result.output);
    await saveBundle(worktree.path, base, join(root, "implement.bundle"));
    return result.sha;
  };
  const remote = () => ({ url: source, env: {} });
  const push = (sha: string, over: { baseSha?: string; branch?: string; env?: Record<string, string>; mode?: PushMode } = {}): Promise<void> =>
    pushCommit({
      scratchDir: join(root, "scratch"),
      objectsDir: join(mirror.path, "objects"),
      bundlePath: join(root, "implement.bundle"),
      remote: { url: source, env: over.env ?? {} },
      sha,
      baseSha: over.baseSha ?? base,
      branch: over.branch ?? "fix/API-1-keep-last-chunk",
      identifier: "API-1",
      branchTypes: TYPES,
      mode: over.mode ?? { kind: "create" },
    });

  it("pushes the commit to a new branch", async () => {
    const sha = await commitChange();
    await push(sha);
    expect(await git(source, ["rev-parse", "refs/heads/fix/API-1-keep-last-chunk"])).toBe(sha);
  });

  it("refuses a branch outside the pattern", async () => {
    const sha = await commitChange();
    await expect(push(sha, { branch: "main" })).rejects.toThrow("refusing to push to refs/heads/main");
  });

  it("refuses a commit that is not directly on the base", async () => {
    const sha = await commitChange();
    await expect(push(sha, { baseSha: "b".repeat(40) })).rejects.toThrow("is not a single commit on top of");
  });

  it("refuses when any branch already carries the ticket", async () => {
    await git(source, ["branch", "feature/API-1-by-hand", base]);
    const sha = await commitChange();
    expect(await remoteTicketBranches(remote(), worktree.path, "API-1")).toEqual([{ ref: "refs/heads/feature/API-1-by-hand", sha: base }]);
    await expect(push(sha)).rejects.toBeInstanceOf(BranchExistsError);
  });

  it("is create-only: an existing same-name ref at the base is not fast-forwarded", async () => {
    const sha = await commitChange();
    await git(source, ["branch", "fix/API-1-keep-last-chunk", base]);
    await expect(push(sha, { branch: "fix/API-1-keep-last-chunk" })).rejects.toThrow();
    expect(await git(source, ["rev-parse", "refs/heads/fix/API-1-keep-last-chunk"])).toBe(base);
  });

  it("pushes from the bundle and mirror objects after the worktree is gone", async () => {
    const sha = await commitChange();
    await worktree.destroy();
    await push(sha, { branch: "fix/API-1-x" });
    expect(await git(source, ["rev-parse", "refs/heads/fix/API-1-x"])).toBe(sha);
  });

  describe("fastForward", () => {
    const BRANCH = "fix/API-1-keep-last-chunk";
    const REF = `refs/heads/${BRANCH}`;
    /** Pushes a first commit, then commits a second on top of it and bundles it against the first. */
    const pushedThenChild = async (): Promise<{ first: string; second: string }> => {
      const first = await commitChange();
      await push(first, { branch: BRANCH });
      await writeFile(join(worktree.path, "src/a.ts"), "export const a = 3;\n");
      await stageAndGuard({ worktreePath: worktree.path, stewardFiles: [], secretValues: [] });
      const result = await commitWithHooks({ worktreePath: worktree.path, hooksDir: join(root, "hooks"), messagePath: join(root, "MSG"), message: "API-1: y", author: AUTHOR, env: env() });
      if (!result.ok) throw new Error(result.output);
      await saveBundle(worktree.path, first, join(root, "implement.bundle"));
      return { first, second: result.sha };
    };

    it("updates the remote branch from the previous head to a child commit", async () => {
      const { first, second } = await pushedThenChild();
      await push(second, { branch: BRANCH, baseSha: first, mode: { kind: "fastForward", previousHead: first } });
      expect(await git(source, ["rev-parse", REF])).toBe(second);
    });

    it("throws and leaves the remote alone when the branch moved past the previous head", async () => {
      const { first, second } = await pushedThenChild();
      await git(source, ["branch", "-f", BRANCH, base]);
      await expect(push(second, { branch: BRANCH, baseSha: first, mode: { kind: "fastForward", previousHead: first } })).rejects.toThrow();
      expect(await git(source, ["rev-parse", REF])).toBe(base);
    });

    it("refuses a commit whose parent is not the previous head", async () => {
      const { first, second } = await pushedThenChild();
      await expect(push(second, { branch: BRANCH, baseSha: base, mode: { kind: "fastForward", previousHead: first } })).rejects.toThrow("not a single commit on top of");
    });
  });

  it("never runs an agent-planted pre-push hook (worktree or mirror hooksPath)", async () => {
    const sha = await commitChange();
    const evilDir = join(root, "evil");
    const leak = join(root, "leaked-env");
    await mkdir(evilDir, { recursive: true });
    await writeFile(join(evilDir, "pre-push"), `#!/bin/sh\nenv > ${leak}\n`);
    await chmod(join(evilDir, "pre-push"), 0o755);
    await git(worktree.path, ["config", "--worktree", "core.hooksPath", evilDir]);
    await git(mirror.path, ["config", "core.hooksPath", evilDir]);
    await push(sha, { env: { GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "http.extraHeader", GIT_CONFIG_VALUE_0: "Authorization: Basic c2VjcmV0" } });
    expect(existsSync(leak)).toBe(false);
  });
});

describe("bundleBase", () => {
  it("reads the single prerequisite from a bundle made by saveBundle", async () => {
    await writeFile(join(worktree.path, "src/a.ts"), "export const a = 2;\n");
    await stageAndGuard({ worktreePath: worktree.path, stewardFiles: [], secretValues: [] });
    await installHookWrappers(worktree.path, join(root, "hooks"));
    const result = await commitWithHooks({ worktreePath: worktree.path, hooksDir: join(root, "hooks"), messagePath: join(root, "MSG"), message: "API-1: x", author: AUTHOR, env: env() });
    if (!result.ok) throw new Error(result.output);
    await saveBundle(worktree.path, base, join(root, "implement.bundle"));
    expect(await bundleBase(join(root, "implement.bundle"))).toBe(base);
  });

  it("parses a v3 header with capabilities", async () => {
    const path = join(root, "v3.bundle");
    await writeFile(path, `# v3 git bundle\n@object-format=sha1\n-${"a".repeat(40)} base commit\n${"b".repeat(40)} HEAD\n\nPACK`);
    expect(await bundleBase(path)).toBe("a".repeat(40));
  });

  it("throws without exactly one prerequisite", async () => {
    const none = join(root, "none.bundle");
    await writeFile(none, `# v2 git bundle\n${"b".repeat(40)} HEAD\n\nPACK`);
    await expect(bundleBase(none)).rejects.toThrow();
    const two = join(root, "two.bundle");
    await writeFile(two, `# v2 git bundle\n-${"a".repeat(40)}\n-${"c".repeat(40)} x\n${"b".repeat(40)} HEAD\n\nPACK`);
    await expect(bundleBase(two)).rejects.toThrow();
  });

  it("throws on a file that is not a bundle", async () => {
    const path = join(root, "junk.bundle");
    await writeFile(path, "hello\n");
    await expect(bundleBase(path)).rejects.toThrow();
  });
});
