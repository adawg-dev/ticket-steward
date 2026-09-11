import { join } from "node:path";

import { Mirror, injectToken } from "../../src/workspace/index.js";
import { commitFile, makeSourceRepo, removeDir, tmpDir } from "./helpers.js";

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
