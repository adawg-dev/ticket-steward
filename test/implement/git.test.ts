import { existsSync } from "node:fs";
import { chmod, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { BranchExistsError, type GuardResult, type PushMode, bundleBase, guardRange, linearRangeProblem, pushCommit, remoteTicketBranches, saveBundle, unpushedWork } from "../../src/implement/git.js";
import { Mirror } from "../../src/workspace/mirror.js";
import { createWorktree, type Worktree } from "../../src/workspace/worktree.js";
import { commitFile, git, makeSourceRepo, removeDir, tmpDir } from "../workspace/helpers.js";

const TYPES = ["feature", "fix", "chore", "refactor"];

let root: string;
let source: string;
let base: string;
let mirror: Mirror;
let worktree: Worktree;

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

/** Commits everything in the worktree, as the agent would. */
const commitAll = async (message: string): Promise<string> => {
  await git(worktree.path, ["add", "-A"]);
  await git(worktree.path, ["commit", "--quiet", "--no-gpg-sign", "-m", message]);
  return git(worktree.path, ["rev-parse", "HEAD"]);
};

describe("guardRange", () => {
  const guard = { stewardFiles: [".env"], secretValues: ["sk-live-abcdef123456"] };
  const commit = async (content: string, message: string): Promise<string> => {
    await writeFile(join(worktree.path, "src/a.ts"), content);
    await git(worktree.path, ["add", "src/a.ts"]);
    await git(worktree.path, ["commit", "--quiet", "--no-gpg-sign", "-m", message]);
    return git(worktree.path, ["rev-parse", "HEAD"]);
  };

  it("passes several clean commits on the base", async () => {
    await commit("export const a = 2;\n", "API-1: one");
    const head = await commit("export const a = 3;\n", "API-1: two");
    expect(await guardRange({ worktreePath: worktree.path, baseSha: base, headSha: head, ...guard })).toEqual({ ok: true, paths: ["src/a.ts"] });
  });

  it("refuses a secret added in one commit even when a later one removes it", async () => {
    const leaking = await commit("export const a = 'sk-live-abcdef123456';\n", "API-1: one");
    const head = await commit("export const a = 3;\n", "API-1: two");
    // The combined diff no longer shows it, but the first commit still carries it to the remote.
    expect(await guardRange({ worktreePath: worktree.path, baseSha: base, headSha: head, ...guard })).toEqual({
      ok: false,
      reason: "the change contains a secret value",
      detail: `commit ${leaking.slice(0, 7)}: src/a.ts`,
    });
  });

  const guardHead = async (over: { maxDiffBytes?: number } = {}): Promise<GuardResult> =>
    guardRange({ worktreePath: worktree.path, baseSha: base, headSha: await git(worktree.path, ["rev-parse", "HEAD"]), ...guard, ...over });

  it("refuses an empty range", async () => {
    expect(await guardRange({ worktreePath: worktree.path, baseSha: base, headSha: base, ...guard })).toMatchObject({ ok: false, reason: "the agent reported the work as implemented but changed nothing" });
  });

  it("refuses a committed steward copy", async () => {
    await writeFile(join(worktree.path, ".env"), "TOKEN=abc123abc123\n");
    await writeFile(join(worktree.path, "src/a.ts"), "export const a = 2;\n");
    await git(worktree.path, ["add", "-f", ".env"]);
    await commitAll("API-1: one");
    expect(await guardHead()).toEqual({ ok: false, reason: "the change would commit files the steward copied in", detail: ".env" });
  });

  it("finds a secret in a binary file", async () => {
    await writeFile(join(worktree.path, "blob.bin"), Buffer.from("\0sk-live-abcdef123456\0"));
    await commitAll("API-1: one");
    expect(await guardHead()).toEqual({ ok: false, reason: "the change contains a secret value", detail: "blob.bin" });
  });

  it("finds a secret when .gitattributes marks the file -diff", async () => {
    await writeFile(join(worktree.path, ".gitattributes"), "*.ts -diff\n");
    await writeFile(join(worktree.path, "src/a.ts"), 'export const key = "sk-live-abcdef123456";\n');
    await commitAll("API-1: one");
    expect(await guardHead()).toEqual({ ok: false, reason: "the change contains a secret value", detail: "src/a.ts" });
  });

  it("finds a secret on an added line that starts with ++", async () => {
    await writeFile(join(worktree.path, "src/a.ts"), "export const a = 1;\n++sk-live-abcdef123456\n");
    await commitAll("API-1: one");
    expect(await guardHead()).toEqual({ ok: false, reason: "the change contains a secret value", detail: "src/a.ts" });
  });

  it("names a file whose name is pathspec magic or needs quoting", async () => {
    await writeFile(join(worktree.path, ":(glob)zz"), "sk-live-abcdef123456\n");
    await writeFile(join(worktree.path, 'tab\t"q"\u00e9.txt'), "sk-live-abcdef123456\n");
    await commitAll("API-1: one");
    expect(await guardHead()).toEqual({ ok: false, reason: "the change contains a secret value", detail: ':(glob)zz\ntab\t"q"\u00e9.txt' });
  });

  it("refuses a change too large to scan instead of scanning a truncated diff", async () => {
    await writeFile(join(worktree.path, "src/big.txt"), `${"x".repeat(80)}\n`.repeat(100) + "sk-live-abcdef123456\n");
    await commitAll("API-1: one");
    expect(await guardHead({ maxDiffBytes: 1024 })).toEqual({ ok: false, reason: "the change is too large to scan for secrets", detail: "src/big.txt" });
  });

  it("refuses, rather than passes, when the secret scan's diff fails", async () => {
    await writeFile(join(worktree.path, "src/a.ts"), "export const a = 2;\n");
    const sha = await commitAll("API-1: one");
    // The tree diff still lists the path, but the blob is gone, so the per-file content diff exits non-zero.
    const blob = await git(worktree.path, ["rev-parse", `${sha}:src/a.ts`]);
    await rm(await git(worktree.path, ["rev-parse", "--path-format=absolute", "--git-path", `objects/${blob.slice(0, 2)}/${blob.slice(2)}`]));
    expect(await guardHead()).toEqual({ ok: false, reason: "the change could not be scanned for secrets", detail: "src/a.ts" });
  });

  it("refuses any commit message in the range that carries a secret, naming the commit", async () => {
    const leaking = await commit("export const a = 2;\n", "API-1: one\n\nsk-live-abcdef123456");
    const head = await commit("export const a = 3;\n", "API-1: two");
    expect(await guardRange({ worktreePath: worktree.path, baseSha: base, headSha: head, ...guard })).toEqual({
      ok: false,
      reason: "the commit message contains a secret value",
      detail: `commit ${leaking.slice(0, 7)}`,
    });
  });
});

describe("linearRangeProblem", () => {
  it("accepts a linear series and names a merge or a missing base", async () => {
    await writeFile(join(worktree.path, "src/a.ts"), "export const a = 2;\n");
    await git(worktree.path, ["commit", "--quiet", "-am", "one"]);
    const one = await git(worktree.path, ["rev-parse", "HEAD"]);
    expect(await linearRangeProblem(worktree.path, base, one)).toBeNull();
    expect(await linearRangeProblem(worktree.path, base, base)).toBe(`there are no commits on top of ${base.slice(0, 7)}`);
    expect(await linearRangeProblem(worktree.path, one, base)).toBe(`${base.slice(0, 7)} does not descend from ${one.slice(0, 7)}`);
  });
});

describe("unpushedWork", () => {
  it("names modified, staged and untracked paths in full, leaving out the steward's files", async () => {
    await writeFile(join(worktree.path, "src/a.ts"), "export const a = 2;\n");
    await writeFile(join(worktree.path, "src/b.ts"), "export const b = 1;\n");
    await git(worktree.path, ["add", "src/b.ts"]);
    await writeFile(join(worktree.path, "notes.md"), "draft\n");
    await writeFile(join(worktree.path, "steward.json"), "{}\n");

    const work = await unpushedWork({ worktreePath: worktree.path, pushedSha: base, stewardFiles: ["steward.json"] });

    expect(work).toEqual({ uncommitted: ["src/a.ts", "src/b.ts", "notes.md"], commits: [], summary: "uncommitted:\n  src/a.ts\n  src/b.ts\n  notes.md" });
  });

  it("lists the commits on HEAD past the pushed sha, and nothing for a clean worktree at it", async () => {
    expect(await unpushedWork({ worktreePath: worktree.path, pushedSha: base, stewardFiles: [] })).toEqual({ uncommitted: [], commits: [], summary: "" });
    await writeFile(join(worktree.path, "src/a.ts"), "export const a = 2;\n");
    await git(worktree.path, ["commit", "--quiet", "-am", "API-1: one"]);
    const one = await git(worktree.path, ["rev-parse", "--short=7", "HEAD"]);

    expect(await unpushedWork({ worktreePath: worktree.path, pushedSha: base, stewardFiles: [] })).toEqual({ uncommitted: [], commits: [`${one} API-1: one`], summary: `commits not pushed:\n  ${one} API-1: one` });
  });
});

describe("push", () => {
  const commitChange = async (): Promise<string> => {
    await writeFile(join(worktree.path, "src/a.ts"), "export const a = 2;\n");
    const sha = await commitAll("API-1: x");
    await saveBundle(worktree.path, base, join(root, "implement.bundle"));
    return sha;
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

  it("refuses a commit that does not descend from the base", async () => {
    const sha = await commitChange();
    await expect(push(sha, { baseSha: "b".repeat(40) })).rejects.toThrow("does not descend from bbbbbbb");
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
      const second = await commitAll("API-1: y");
      await saveBundle(worktree.path, first, join(root, "implement.bundle"));
      return { first, second };
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

    it("refuses a commit that does not descend from the previous head", async () => {
      const { first, second } = await pushedThenChild();
      await expect(push(first, { branch: BRANCH, baseSha: first, mode: { kind: "fastForward", previousHead: second } })).rejects.toThrow(`${first.slice(0, 7)} does not descend from ${second.slice(0, 7)}`);
    });

    it("fast-forwards several linear commits at once", async () => {
      const { first, second } = await pushedThenChild();
      await git(source, ["branch", "-f", BRANCH, base]);
      await saveBundle(worktree.path, base, join(root, "implement.bundle"));
      await push(second, { branch: BRANCH, baseSha: base, mode: { kind: "fastForward", previousHead: base } });
      expect(await git(source, ["rev-list", "--count", `${base}..${REF}`])).toBe("2");
      expect(await git(source, ["rev-parse", `${REF}~1`])).toBe(first);
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
    await commitAll("API-1: x");
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
