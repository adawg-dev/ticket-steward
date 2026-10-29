import { link, mkdir, symlink, truncate, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { MAX_MEDIA_BYTES, renderMedia, uploadMedia } from "../../src/codehost/media.js";
import { FakeGitLabMr } from "../fakes/fakeGitLabMr.js";
import { removeDir, tmpDir } from "../workspace/helpers.js";

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);
const WEBM = Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0, 0, 0, 0]);

let root: string;
let artifacts: string;

beforeEach(async () => {
  root = await tmpDir();
  artifacts = join(root, "jobs", "7", "artifacts");
  await mkdir(artifacts, { recursive: true });
});

afterEach(async () => {
  await removeDir(root);
});

describe("uploadMedia", () => {
  it("uploads screenshots and videos in the artifacts dir and returns their embeds with captions", async () => {
    const gitlab = new FakeGitLabMr();
    await writeFile(join(artifacts, "after.png"), PNG);
    await mkdir(join(artifacts, "videos"));
    await writeFile(join(artifacts, "videos", "flow.webm"), WEBM);

    const uploads = await uploadMedia(gitlab, "acme/repo", artifacts, [
      { path: "after.png", caption: "The settings page after the change" },
      { path: join(artifacts, "videos", "flow.webm"), caption: "Saving a profile" },
    ]);

    expect(uploads.rejected).toEqual([]);
    expect(uploads.embeds).toEqual([
      { caption: "The settings page after the change", markdown: "![after.png](/uploads/1/after.png)" },
      { caption: "Saving a profile", markdown: "![flow.webm](/uploads/2/flow.webm)" },
    ]);
    expect(gitlab.uploads).toEqual([
      { project: "acme/repo", filename: "after.png", bytes: PNG.length },
      { project: "acme/repo", filename: "flow.webm", bytes: WEBM.length },
    ]);
  });

  it("rejects a symlink that leads out of the artifacts dir, and a path that climbs out", async () => {
    const gitlab = new FakeGitLabMr();
    await writeFile(join(root, "secret.png"), PNG);
    await symlink(join(root, "secret.png"), join(artifacts, "shot.png"));

    const uploads = await uploadMedia(gitlab, 42, artifacts, [
      { path: "shot.png", caption: "a" },
      { path: "../../../secret.png", caption: "b" },
    ]);

    expect(uploads.embeds).toEqual([]);
    expect(uploads.rejected).toEqual([
      { name: "shot.png", reason: "outside the artifacts directory" },
      { name: "secret.png", reason: "outside the artifacts directory" },
    ]);
    expect(gitlab.uploads).toEqual([]);
  });

  it("rejects what is not an image or a video, by name and by content", async () => {
    const gitlab = new FakeGitLabMr();
    await writeFile(join(artifacts, "tool.exe"), "MZ");
    await writeFile(join(artifacts, "notes.png"), "DATABASE_URL=postgres://x\n");

    const uploads = await uploadMedia(gitlab, 42, artifacts, [
      { path: "tool.exe", caption: "a" },
      { path: "notes.png", caption: "b" },
    ]);

    expect(uploads.rejected).toEqual([
      { name: "tool.exe", reason: "not an image or video (png, jpg, jpeg, gif, webp, mp4, webm)" },
      { name: "notes.png", reason: "not a png file" },
    ]);
    expect(gitlab.uploads).toEqual([]);
  });

  it("rejects a file over 25 MB, a hard link and a missing file", async () => {
    const gitlab = new FakeGitLabMr();
    await writeFile(join(artifacts, "big.png"), PNG);
    await truncate(join(artifacts, "big.png"), 26 * 1024 * 1024);
    await writeFile(join(root, "elsewhere.png"), PNG);
    await link(join(root, "elsewhere.png"), join(artifacts, "linked.png"));

    const uploads = await uploadMedia(gitlab, 42, artifacts, [
      { path: "big.png", caption: "a" },
      { path: "linked.png", caption: "b" },
      { path: "gone.png", caption: "c" },
    ]);

    expect(26 * 1024 * 1024).toBeGreaterThan(MAX_MEDIA_BYTES);
    expect(uploads.rejected).toEqual([
      { name: "big.png", reason: "larger than 25 MB" },
      { name: "linked.png", reason: "a hard link" },
      { name: "gone.png", reason: "not found" },
    ]);
    expect(gitlab.uploads).toEqual([]);
  });

  it("uploads at most 10 files and lists the rest", async () => {
    const gitlab = new FakeGitLabMr();
    const media = Array.from({ length: 12 }, (_, n) => ({ path: `shot-${n}.png`, caption: `step ${n}` }));
    for (const item of media) await writeFile(join(artifacts, item.path), PNG);

    const uploads = await uploadMedia(gitlab, 42, artifacts, media);

    expect(uploads.embeds).toHaveLength(10);
    expect(uploads.rejected).toEqual([
      { name: "shot-10.png", reason: "more than 10 files" },
      { name: "shot-11.png", reason: "more than 10 files" },
    ]);
  });

  it("lists a failed upload instead of failing", async () => {
    const gitlab = new FakeGitLabMr();
    gitlab.failNextUpload();
    await writeFile(join(artifacts, "a.png"), PNG);
    await writeFile(join(artifacts, "b.png"), PNG);

    const uploads = await uploadMedia(gitlab, 42, artifacts, [
      { path: "a.png", caption: "a" },
      { path: "b.png", caption: "b" },
    ]);

    expect(uploads.rejected).toEqual([{ name: "a.png", reason: "upload failed: GitLab down" }]);
    expect(uploads.embeds.map((embed) => embed.caption)).toEqual(["b"]);
  });
});

describe("renderMedia", () => {
  it("renders each embed under its caption and lists what was not attached", () => {
    expect(renderMedia({
      embeds: [{ caption: "After", markdown: "![a.png](/uploads/1/a.png)" }],
      rejected: [{ name: "tool.exe", reason: "not an image or video (png, jpg, jpeg, gif, webp, mp4, webm)" }],
    })).toEqual([
      "**Screenshots and recordings**",
      "",
      "After",
      "",
      "![a.png](/uploads/1/a.png)",
      "",
      "Not attached: `tool.exe` (not an image or video (png, jpg, jpeg, gif, webp, mp4, webm))",
    ]);
  });

  it("renders nothing without media", () => {
    expect(renderMedia(undefined)).toEqual([]);
    expect(renderMedia({ embeds: [], rejected: [] })).toEqual([]);
  });
});
