import { constants } from "node:fs";
import { open, realpath } from "node:fs/promises";
import { basename, extname, isAbsolute, relative, resolve } from "node:path";
import { z } from "zod";
import type { GitLabMrApi, ProjectRef } from "./gitlabMr.js";

/**
 * Screenshots and recordings the agent made of its change, attached to the merge request. The agent only names files in
 * its artifacts dir; the steward checks each one and uploads it with its own GitLab access.
 */

export const MAX_MEDIA_FILES = 10;
export const MAX_MEDIA_BYTES = 25 * 1024 * 1024;

/** A file the agent made under the artifacts dir (relative to it, or absolute) and a one-line caption. */
export const MediaItemSchema = z.object({ path: z.string(), caption: z.string() });
export type MediaItem = z.infer<typeof MediaItemSchema>;

/** A result's `media`: empty when the change shows nothing. Defaults to empty so results stored before it still parse. */
export const MediaListSchema = z.array(MediaItemSchema).default([]);

/** What was attached (the upload's Markdown, under its caption) and what was not, by file name and why. */
export const MediaUploadsSchema = z.object({
  embeds: z.array(z.object({ caption: z.string(), markdown: z.string() })),
  rejected: z.array(z.object({ name: z.string(), reason: z.string() })),
});
export type MediaUploads = z.infer<typeof MediaUploadsSchema>;

export type MediaUploader = Pick<GitLabMrApi, "uploadFile">;

/** The first bytes each kind of file starts with: a file named `.png` must be one. */
const SIGNATURES: Record<string, (head: Buffer) => boolean> = {
  png: (head) => head.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
  jpg: (head) => head.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff])),
  jpeg: (head) => head.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff])),
  gif: (head) => ["GIF87a", "GIF89a"].includes(head.subarray(0, 6).toString("latin1")),
  webp: (head) => head.subarray(0, 4).toString("latin1") === "RIFF" && head.subarray(8, 12).toString("latin1") === "WEBP",
  mp4: (head) => head.subarray(4, 8).toString("latin1") === "ftyp",
  webm: (head) => head.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3])),
};
const EXTENSIONS = Object.keys(SIGNATURES);
const HEAD_BYTES = 12;

const errorMessage = (err: unknown): string => (err instanceof Error ? err.message : String(err));

const kindOf = (path: string): string | null => {
  const ext = extname(path).slice(1).toLowerCase();
  return Object.hasOwn(SIGNATURES, ext) ? ext : null;
};

/** Why a file cannot be attached; thrown by `readMedia`, listed by `uploadMedia`. */
class Rejected extends Error {}

/**
 * The file's bytes, once it is a regular file inside `realDir` (after every symlink), not hard-linked from elsewhere, at
 * most 25 MB, and an image or video by both its name and its first bytes.
 */
const readMedia = async (realDir: string, artifactsDir: string, path: string): Promise<{ name: string; data: Buffer }> => {
  if (kindOf(path) === null) throw new Rejected(`not an image or video (${EXTENSIONS.join(", ")})`);
  let real: string;
  try {
    real = await realpath(resolve(artifactsDir, path));
  } catch {
    throw new Rejected("not found");
  }
  const inside = relative(realDir, real);
  if (inside === "" || inside.startsWith("..") || isAbsolute(inside)) throw new Rejected("outside the artifacts directory");
  const kind = kindOf(real);
  if (kind === null) throw new Rejected(`not an image or video (${EXTENSIONS.join(", ")})`);
  // No symlink can be swapped in between the check and the read: the checks below are on the file this opened.
  const handle = await open(real, constants.O_RDONLY | constants.O_NOFOLLOW).catch(() => {
    throw new Rejected("not found");
  });
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) throw new Rejected("not a file");
    if (stat.nlink > 1) throw new Rejected("a hard link");
    if (stat.size > MAX_MEDIA_BYTES) throw new Rejected("larger than 25 MB");
    const data = await handle.readFile();
    if (data.length > MAX_MEDIA_BYTES) throw new Rejected("larger than 25 MB");
    const check = SIGNATURES[kind];
    if (check === undefined || !check(data.subarray(0, HEAD_BYTES))) throw new Rejected(`not a ${kind} file`);
    return { name: basename(real), data };
  } finally {
    await handle.close();
  }
};

/** Every item listed as not attached, for the same reason (no GitLab to upload to, the uploader unreachable). */
export const rejectAll = (media: MediaItem[], reason: string): MediaUploads => ({
  embeds: [],
  rejected: media.map((item) => ({ name: basename(item.path), reason })),
});

/**
 * Uploads the agent's media to the project (`POST /projects/:id/uploads`), at most 10 files, each checked by `readMedia`.
 * A file that fails a check or its upload is listed with the reason; this never throws for one file.
 */
export const uploadMedia = async (gitlab: MediaUploader, projectId: ProjectRef, artifactsDir: string, media: MediaItem[]): Promise<MediaUploads> => {
  const uploads: MediaUploads = { embeds: [], rejected: [] };
  let realDir: string;
  try {
    realDir = await realpath(artifactsDir);
  } catch {
    return rejectAll(media, "not found");
  }
  for (const [index, item] of media.entries()) {
    const name = basename(item.path);
    if (index >= MAX_MEDIA_FILES) {
      uploads.rejected.push({ name, reason: `more than ${MAX_MEDIA_FILES} files` });
      continue;
    }
    let file: { name: string; data: Buffer };
    try {
      file = await readMedia(realDir, artifactsDir, item.path);
    } catch (err) {
      uploads.rejected.push({ name, reason: err instanceof Rejected ? err.message : `unreadable: ${errorMessage(err)}` });
      continue;
    }
    try {
      const { markdown } = await gitlab.uploadFile(projectId, file.name, file.data);
      uploads.embeds.push({ caption: item.caption.trim(), markdown });
    } catch (err) {
      uploads.rejected.push({ name, reason: `upload failed: ${errorMessage(err)}` });
    }
  }
  return uploads;
};

/**
 * The run's media: what the run pod's tools sidecar attached (`attached`), else, on the local runtime, `items` uploaded
 * here from the artifacts dir. Undefined when there is nothing to show; without GitLab every item is listed as not attached.
 */
export const attachedMedia = async (p: {
  attached: MediaUploads | undefined;
  items: MediaItem[];
  artifactsDir: string;
  gitlab: MediaUploader | undefined;
  project: ProjectRef | null;
}): Promise<MediaUploads | undefined> => {
  if (p.attached !== undefined) return p.attached.embeds.length === 0 && p.attached.rejected.length === 0 ? undefined : p.attached;
  if (p.items.length === 0) return undefined;
  if (p.gitlab === undefined || p.project === null) return rejectAll(p.items, "media is attached on GitLab only");
  return uploadMedia(p.gitlab, p.project, p.artifactsDir, p.items);
};

/** The note lines for the media: each embed under its caption, then what was not attached. Nothing without media. */
export const renderMedia = (uploads: MediaUploads | undefined): string[] => {
  if (uploads === undefined || (uploads.embeds.length === 0 && uploads.rejected.length === 0)) return [];
  const embeds = uploads.embeds.flatMap((embed, n) => [...(n === 0 ? [] : [""]), ...(embed.caption === "" ? [] : [embed.caption, ""]), embed.markdown]);
  const rejected = uploads.rejected.map((item) => `Not attached: \`${item.name.replaceAll("`", "'")}\` (${item.reason})`);
  return [
    "**Screenshots and recordings**",
    ...(embeds.length === 0 ? [] : ["", ...embeds]),
    ...(rejected.length === 0 ? [] : ["", ...rejected]),
  ];
};
