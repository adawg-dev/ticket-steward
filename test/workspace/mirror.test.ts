import { existsSync } from "node:fs";
import { stat } from "node:fs/promises";
import { join } from "node:path";

import { Mirror, createWorktree, injectToken } from "../../src/workspace/index.js";
import { commitFile, git, makeSourceRepo, removeDir, serveGitHttp, tmpDir } from "./helpers.js";

const TOKEN = "glpat-SECRET";
const basicAuth = `Basic ${Buffer.from(`oauth2:${TOKEN}`).toString("base64")}`;

describe("Mirror", () => {
  let root: string;

  beforeEach(async () => {
    vi.restoreAllMocks();
    root = await tmpDir();
  });

  afterEach(async () => {
    await removeDir(root);
  });

  it("init creates a bare mirror with the worktreeConfig extension", async () => {
    const { repo, sha } = await makeSourceRepo(root);
    const mirrorPath = join(root, "repo.git");

    const mirror = await Mirror.init(mirrorPath, repo);

    expect(mirror.exists()).toBe(true);
    expect(await mirror.hasWorktreeConfigExtension()).toBe(true);
    expect(await mirror.resolveSha("main")).toBe(sha);
    expect(await mirror.resolveSha("origin/main")).toBe(sha);
  });

  it("exists is false before init and the extension is absent on a plain bare repo", async () => {
    const mirror = new Mirror(join(root, "missing.git"), "/nowhere");

    expect(mirror.exists()).toBe(false);
  });

  it("fetch names the fix when the mirror was never initialised", async () => {
    const mirror = new Mirror(join(root, "missing.git"), "/nowhere");

    await expect(mirror.fetch()).rejects.toThrow(`mirror ${join(root, "missing.git")} does not exist; run steward mirror init`);
  });

  it("fetch picks up a new commit from the source", async () => {
    const { repo } = await makeSourceRepo(root);
    const mirror = await Mirror.init(join(root, "repo.git"), repo);
    const next = await commitFile(repo, "second.txt", "two\n");

    await mirror.fetch();

    expect(await mirror.resolveSha("main")).toBe(next);
  });

  it("init creates the mirror and its parent directories with mode 0700", async () => {
    const { repo } = await makeSourceRepo(root);
    const mirrorPath = join(root, "data", "repo.git");

    await Mirror.init(mirrorPath, repo);

    expect((await stat(join(root, "data"))).mode & 0o777).toBe(0o700);
    expect((await stat(mirrorPath)).mode & 0o777).toBe(0o700);
  });

  it("authenticates clone and fetch with the token but never writes it into the mirror or worktree config", async () => {
    const { sha } = await makeSourceRepo(root);
    const server = await serveGitHttp(root);
    const plainUrl = `${server.url}/source`;
    const mirrorPath = join(root, "repo.git");

    const mirror = await Mirror.init(mirrorPath, injectToken(plainUrl, TOKEN));
    await mirror.fetch();
    const worktree = await createWorktree(mirror, join(root, "work"), "1-1", sha);

    expect(await mirror.resolveSha("main")).toBe(sha);
    expect(await git(mirrorPath, ["config", "--get", "remote.origin.url"])).toBe(plainUrl);
    expect(await git(worktree.path, ["config", "--get", "remote.origin.url"])).toBe(plainUrl);
    expect(await git(mirrorPath, ["config", "--list"])).not.toContain(TOKEN);
    expect(server.authorizations.length).toBeGreaterThan(0);
    expect(new Set(server.authorizations)).toEqual(new Set([basicAuth]));
    await server.close();
  });

  it("fetches a merge-request head ref that no branch points at", async () => {
    const { repo } = await makeSourceRepo(root);
    await git(repo, ["checkout", "-q", "-b", "fix"]);
    const head = await commitFile(repo, "src/fix.ts", "export const fix = 1;\n");
    await git(repo, ["update-ref", "refs/merge-requests/7/head", head]);
    await git(repo, ["checkout", "-q", "main"]);
    await git(repo, ["branch", "-D", "fix"]);
    const mirror = await Mirror.init(join(root, "mirror.git"), repo);
    await mirror.fetchRef("refs/merge-requests/7/head");
    expect(await mirror.resolveSha(head)).toBe(head);
  });

  it("runs fetch, fetchRef and worktree add under the mirror's exclusive section", async () => {
    const { repo, sha } = await makeSourceRepo(root);
    const mirror = await Mirror.init(join(root, "repo.git"), repo);
    const exclusive = vi.spyOn(mirror, "exclusive");

    await mirror.fetch();
    await mirror.fetchRef("refs/heads/main");
    const worktree = await createWorktree(mirror, join(root, "work"), "1-1", sha);
    await worktree.destroy();

    expect(exclusive).toHaveBeenCalledTimes(4);
  });

  it("serializes concurrent fetches from two Mirror objects on one path so both succeed", async () => {
    const { repo } = await makeSourceRepo(root);
    const mirror = await Mirror.init(join(root, "repo.git"), repo);
    const other = new Mirror(join(root, "repo.git"), repo);
    const next = await commitFile(repo, "second.txt", "two\n");

    await Promise.all([mirror.fetch(), other.fetch(), mirror.fetchRef("refs/heads/main")]);

    expect(await mirror.resolveSha("main")).toBe(next);
  });

  it("adds and removes worktrees concurrently without git lock errors", async () => {
    const { repo, sha } = await makeSourceRepo(root);
    const mirror = await Mirror.init(join(root, "repo.git"), repo);
    const work = join(root, "work");
    const first = await createWorktree(mirror, work, "1-1", sha);

    const [second, third] = await Promise.all([createWorktree(mirror, work, "2-1", sha), createWorktree(mirror, work, "3-1", sha), first.destroy()]);

    expect(existsSync(first.path)).toBe(false);
    const listed = await git(mirror.path, ["worktree", "list", "--porcelain"]);
    expect(listed).toContain(second.path);
    expect(listed).toContain(third.path);
    expect(listed).not.toContain(first.path);
  });
});

describe("injectToken", () => {
  it("uses oauth2 for gitlab hosts", () => {
    expect(injectToken("https://gitlab.com/group/repo.git", "glpat-abc")).toBe(
      "https://oauth2:glpat-abc@gitlab.com/group/repo.git",
    );
  });

  it("uses x-access-token for github.com", () => {
    expect(injectToken("https://github.com/owner/repo.git", "ghp_abc")).toBe(
      "https://x-access-token:ghp_abc@github.com/owner/repo.git",
    );
  });

  it("uses the given username, e.g. a GitLab deploy token's own username", () => {
    expect(injectToken("https://gitlab.com/group/repo.git", "gldt-abc", "ticket-steward-mirror")).toBe(
      "https://ticket-steward-mirror:gldt-abc@gitlab.com/group/repo.git",
    );
  });

  it("falls back to the host default for an empty username", () => {
    expect(injectToken("https://gitlab.com/group/repo.git", "glpat-abc", "")).toBe(
      "https://oauth2:glpat-abc@gitlab.com/group/repo.git",
    );
  });

  it("returns the url unchanged without a token", () => {
    expect(injectToken("https://gitlab.com/group/repo.git", undefined)).toBe("https://gitlab.com/group/repo.git");
  });

  it("returns a local path unchanged", () => {
    expect(injectToken("/srv/git/repo.git", "glpat-abc")).toBe("/srv/git/repo.git");
  });
});
