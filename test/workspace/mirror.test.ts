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

  it("returns the url unchanged without a token", () => {
    expect(injectToken("https://gitlab.com/group/repo.git", undefined)).toBe("https://gitlab.com/group/repo.git");
  });
});
