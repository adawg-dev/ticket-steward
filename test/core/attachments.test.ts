import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveAttachments } from "../../src/core/attachments.js";

let root: string;
let artifactsDir: string;

beforeEach(async () => {
  vi.restoreAllMocks();
  root = await mkdtemp(join(tmpdir(), "steward-attachments-"));
  artifactsDir = join(root, "artifacts");
  await mkdir(artifactsDir);
  await writeFile(join(root, "outside.png"), "outside");
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("resolveAttachments", () => {
  it("accepts a png inside the artifacts dir with image/png", async () => {
    await writeFile(join(artifactsDir, "shot.png"), "png-bytes");
    const resolved = await resolveAttachments(artifactsDir, [{ file: "shot.png", caption: "Login page" }]);
    expect(resolved).toEqual({
      accepted: [{ path: join(artifactsDir, "shot.png"), caption: "Login page", contentType: "image/png" }],
      notes: [],
    });
  });

  it("drops a path that escapes with .. and records a note", async () => {
    const resolved = await resolveAttachments(artifactsDir, [{ file: "../outside.png", caption: "Escape" }]);
    expect(resolved.accepted).toEqual([]);
    expect(resolved.notes.length).toBe(1);
  });

  it("drops an absolute path", async () => {
    const resolved = await resolveAttachments(artifactsDir, [{ file: join(root, "outside.png"), caption: "Abs" }]);
    expect(resolved.accepted).toEqual([]);
    expect(resolved.notes.length).toBe(1);
  });

  it("drops a symlink pointing outside the artifacts dir", async () => {
    await symlink(join(root, "outside.png"), join(artifactsDir, "link.png"));
    const resolved = await resolveAttachments(artifactsDir, [{ file: "link.png", caption: "Link" }]);
    expect(resolved.accepted).toEqual([]);
    expect(resolved.notes.length).toBe(1);
  });

  it("drops a disallowed extension", async () => {
    await writeFile(join(artifactsDir, "run.sh"), "echo hi");
    const resolved = await resolveAttachments(artifactsDir, [{ file: "run.sh", caption: "Script" }]);
    expect(resolved.accepted).toEqual([]);
    expect(resolved.notes.length).toBe(1);
  });

  it("drops a file larger than 10 MB", async () => {
    await writeFile(join(artifactsDir, "big.log"), Buffer.alloc(10 * 1024 * 1024 + 1));
    const resolved = await resolveAttachments(artifactsDir, [{ file: "big.log", caption: "Big" }]);
    expect(resolved.accepted).toEqual([]);
    expect(resolved.notes.length).toBe(1);
  });

  it("drops a missing file", async () => {
    const resolved = await resolveAttachments(artifactsDir, [{ file: "nope.png", caption: "Missing" }]);
    expect(resolved.accepted).toEqual([]);
    expect(resolved.notes.length).toBe(1);
  });

  it("keeps accepted attachments in request order and maps every allowed extension", async () => {
    await writeFile(join(artifactsDir, "a.jpg"), "a");
    await mkdir(join(artifactsDir, "nested"));
    await writeFile(join(artifactsDir, "nested", "b.json"), "{}");
    await writeFile(join(artifactsDir, "c.txt"), "c");
    const resolved = await resolveAttachments(artifactsDir, [
      { file: "a.jpg", caption: "A" },
      { file: "../outside.png", caption: "Bad" },
      { file: "nested/b.json", caption: "B" },
      { file: "c.txt", caption: "C" },
    ]);
    expect(resolved.accepted).toEqual([
      { path: join(artifactsDir, "a.jpg"), caption: "A", contentType: "image/jpeg" },
      { path: join(artifactsDir, "nested", "b.json"), caption: "B", contentType: "application/json" },
      { path: join(artifactsDir, "c.txt"), caption: "C", contentType: "text/plain" },
    ]);
    expect(resolved.notes.length).toBe(1);
  });
});
