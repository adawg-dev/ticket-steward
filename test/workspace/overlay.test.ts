import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { Mirror, copyOverlay, createWorktree, syncOverlayFromCheckout } from "../../src/workspace/index.js";
import { commitFile, makeSourceRepo, removeDir, tmpDir } from "./helpers.js";

const writeNested = async (dir: string, rel: string, content: string): Promise<void> => {
  await mkdir(join(dir, rel, ".."), { recursive: true });
  await writeFile(join(dir, rel), content);
};

describe("copyOverlay", () => {
  let root: string;
  let worktreePath: string;
  let overlayDir: string;

  beforeEach(async () => {
    vi.restoreAllMocks();
    root = await tmpDir();
    const source = await makeSourceRepo(root);
    await commitFile(source.repo, "apps/web/.env.example", "PORT=\n");
    const mirror = await Mirror.init(join(root, "repo.git"), source.repo);
    const worktree = await createWorktree(mirror, join(root, "work"), "7-1", await mirror.resolveSha("main"));
    worktreePath = worktree.path;
    overlayDir = join(root, "overlay");
    await mkdir(overlayDir);
  });

  afterEach(async () => {
    await removeDir(root);
  });

  it("copies a nested file with mode 0600 and rewrites the port", async () => {
    await writeNested(overlayDir, "apps/web/.env", "URL=http://localhost:3000/api\nLOOP=http://127.0.0.1:3000\n");

    const result = await copyOverlay(overlayDir, worktreePath, { portRewrite: { from: 3000, to: 4100 } });

    expect(result).toEqual({ copied: ["apps/web/.env"] });
    expect(await readFile(join(worktreePath, "apps/web/.env"), "utf8")).toBe(
      "URL=http://localhost:4100/api\nLOOP=http://127.0.0.1:4100\n",
    );
    expect((await stat(join(worktreePath, "apps/web/.env"))).mode & 0o777).toBe(0o600);
  });

  it("copies verbatim without a port rewrite", async () => {
    await writeNested(overlayDir, ".env", "URL=http://localhost:3000\n");

    const result = await copyOverlay(overlayDir, worktreePath, {});

    expect(result).toEqual({ copied: [".env"] });
    expect(await readFile(join(worktreePath, ".env"), "utf8")).toBe("URL=http://localhost:3000\n");
  });

  it("refuses a path that is tracked in git and copies nothing", async () => {
    await writeNested(overlayDir, "apps/web/.env.example", "PORT=9\n");
    await writeNested(overlayDir, "apps/web/.env", "A=1\n");

    await expect(copyOverlay(overlayDir, worktreePath, {})).rejects.toThrow();

    expect(await readFile(join(worktreePath, "apps/web/.env.example"), "utf8")).toBe("PORT=\n");
    await expect(readFile(join(worktreePath, "apps/web/.env"), "utf8")).rejects.toThrow();
  });
});

describe("syncOverlayFromCheckout", () => {
  let root: string;
  let checkout: string;
  let overlayDir: string;

  beforeEach(async () => {
    vi.restoreAllMocks();
    root = await tmpDir();
    const source = await makeSourceRepo(root);
    checkout = source.repo;
    await commitFile(checkout, ".gitignore", ".env\n.env.local\nnode_modules/\n");
    await commitFile(checkout, "apps/web/.env.example", "PORT=\n");
    overlayDir = join(root, "overlay");
  });

  afterEach(async () => {
    await removeDir(root);
  });

  it("copies gitignored .env files with 0600/0700 modes and skips tracked and dependency files", async () => {
    await writeNested(checkout, "apps/web/.env", "DATABASE_URL=postgres://db.local/app\n");
    await writeNested(checkout, ".env.local", "A=1\n");
    await writeNested(checkout, "node_modules/pkg/.env", "B=2\n");

    const result = await syncOverlayFromCheckout(checkout, overlayDir, { denyPatterns: [/prod/i], allowPatterns: [] });

    expect(result).toEqual({ copied: [".env.local", "apps/web/.env"], refused: [] });
    expect(await readFile(join(overlayDir, "apps/web/.env"), "utf8")).toBe("DATABASE_URL=postgres://db.local/app\n");
    expect((await stat(join(overlayDir, "apps/web/.env"))).mode & 0o777).toBe(0o600);
    expect((await stat(join(overlayDir, "apps/web"))).mode & 0o777).toBe(0o700);
    await expect(readFile(join(overlayDir, "apps/web/.env.example"), "utf8")).rejects.toThrow();
  });

  it("refuses a file whose value matches a deny pattern", async () => {
    await writeNested(checkout, "apps/web/.env", 'DATABASE_URL="postgres://db.prod.example.com/app"\n');
    await writeNested(checkout, ".env.local", "A=1\n");

    const result = await syncOverlayFromCheckout(checkout, overlayDir, { denyPatterns: [/prod/i], allowPatterns: [] });

    expect(result.copied).toEqual([".env.local"]);
    expect(result.refused).toHaveLength(1);
    expect(result.refused[0]?.file).toBe("apps/web/.env");
    await expect(readFile(join(overlayDir, "apps/web/.env"), "utf8")).rejects.toThrow();
  });

  it("copies a denied value when an allow pattern matches it", async () => {
    await writeNested(checkout, "apps/web/.env", "DATABASE_URL=postgres://db.prod.example.com/app\n");

    const result = await syncOverlayFromCheckout(checkout, overlayDir, {
      denyPatterns: [/prod/i],
      allowPatterns: [/db\.prod\.example\.com/],
    });

    expect(result).toEqual({ copied: ["apps/web/.env"], refused: [] });
  });

  it("ignores untracked files that git does not ignore", async () => {
    await writeNested(checkout, "apps/web/.env.staging", "A=1\n");

    const result = await syncOverlayFromCheckout(checkout, overlayDir, { denyPatterns: [], allowPatterns: [] });

    expect(result).toEqual({ copied: [], refused: [] });
  });
});
