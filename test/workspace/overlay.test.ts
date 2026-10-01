import { existsSync } from "node:fs";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { Mirror, copyOverlay, createWorktree, syncOverlayFromCheckout } from "../../src/workspace/index.js";
import { missingOverrideKeys, OverrideKeysError } from "../../src/workspace/overlay.js";
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

  it("replaces values unquoted, keeps export and indentation, deletes null keys, leaves every other line", async () => {
    const original = [
      "# local services",
      "DB_HOST=10.2.0.11",
      'export DB_PORT = "5432"',
      "  DB_NAME='concentrate_remote'",
      "REDIS_CLUSTER_NODES=10.2.0.51:7000,10.2.0.51:7001",
      "OTHER=keep me",
      "",
    ].join("\n");
    await writeNested(overlayDir, "e2e/user/.env", original);

    await copyOverlay(overlayDir, worktreePath, { overrides: { DB_HOST: "localhost", DB_PORT: "15132", DB_NAME: "concentrate", REDIS_CLUSTER_NODES: null } });

    expect(await readFile(join(worktreePath, "e2e/user/.env"), "utf8")).toBe(
      ["# local services", "DB_HOST=localhost", "export DB_PORT=15132", "  DB_NAME=concentrate", "OTHER=keep me", ""].join("\n"),
    );
    expect(await readFile(join(overlayDir, "e2e/user/.env"), "utf8")).toBe(original);
  });

  it("applies to every file that defines the key, keeps CRLF and never adds a key", async () => {
    await writeNested(overlayDir, "service/Cron/.env", "TG_CONN_STR=postgres://cloud/tg\r\nX=1\r\n");
    await writeNested(overlayDir, "packages/tigerdb/.env", "TG_CONN_STR=postgres://cloud2/tg\n");
    await writeNested(overlayDir, "apps/web/.env", "Y=2\n");

    await copyOverlay(overlayDir, worktreePath, { overrides: { TG_CONN_STR: "postgres://postgres:steward-slot@localhost:15132/concentrate_tg" } });

    expect(await readFile(join(worktreePath, "service/Cron/.env"), "utf8")).toBe("TG_CONN_STR=postgres://postgres:steward-slot@localhost:15132/concentrate_tg\r\nX=1\r\n");
    expect(await readFile(join(worktreePath, "packages/tigerdb/.env"), "utf8")).toBe("TG_CONN_STR=postgres://postgres:steward-slot@localhost:15132/concentrate_tg\n");
    expect(await readFile(join(worktreePath, "apps/web/.env"), "utf8")).toBe("Y=2\n");
  });

  it("rewrites the port substring, then applies the overrides", async () => {
    await writeNested(overlayDir, "e2e/user/.env", "BASE_URL=http://localhost:3000\nCORS_ORIGIN=http://localhost:3000,https://app.example\nDB_PORT=5432\n");

    await copyOverlay(overlayDir, worktreePath, { portRewrite: { from: 3000, to: 4102 }, overrides: { DB_PORT: "15232" } });

    expect(await readFile(join(worktreePath, "e2e/user/.env"), "utf8")).toBe("BASE_URL=http://localhost:4102\nCORS_ORIGIN=http://localhost:4102,https://app.example\nDB_PORT=15232\n");
  });

  it("fails naming the missing keys, never their values, and writes nothing", async () => {
    await writeNested(overlayDir, "e2e/user/.env", "DB_HOST=10.2.0.11\n");

    const copying = copyOverlay(overlayDir, worktreePath, { overrides: { DB_HOST: "localhost", NOPE: "secret-value-1", ALSO_NOPE: null } });

    await expect(copying).rejects.toBeInstanceOf(OverrideKeysError);
    await expect(copying).rejects.toThrow(/^slot override keys not found in the overlay: NOPE, ALSO_NOPE$/);
    expect(existsSync(join(worktreePath, "e2e/user/.env"))).toBe(false);
  });

  it("missingOverrideKeys lists the keys no overlay file defines", async () => {
    await writeNested(overlayDir, "a/.env", "export DB_HOST=x\n");
    await writeNested(overlayDir, "b/.env", "REDIS_URL = y\n");

    expect(await missingOverrideKeys(overlayDir, ["DB_HOST", "REDIS_URL", "RABBITMQ_URL"])).toEqual(["RABBITMQ_URL"]);
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

  it("fails when the source is not a git checkout instead of copying nothing", async () => {
    const plain = join(root, "plain");
    await writeNested(plain, ".env", "A=1\n");

    await expect(syncOverlayFromCheckout(plain, overlayDir, { denyPatterns: [], allowPatterns: [] })).rejects.toThrow(
      `${plain} is not a git checkout`,
    );
  });
});
