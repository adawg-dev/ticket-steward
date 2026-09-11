import { realpath, stat } from "node:fs/promises";
import { extname, resolve, sep } from "node:path";
import type { BrainResult } from "./result.js";

export interface ResolvedAttachment {
  path: string;
  caption: string;
  contentType: string;
}

const MAX_BYTES = 10 * 1024 * 1024;

const CONTENT_TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".txt": "text/plain",
  ".log": "text/plain",
  ".json": "application/json",
};

const resolveOne = async (
  root: string,
  requested: BrainResult["attachments"][number],
): Promise<ResolvedAttachment | string> => {
  const contentType = CONTENT_TYPES[extname(requested.file).toLowerCase()];
  if (contentType === undefined) return `Attachment \`${requested.file}\` dropped: file type not allowed.`;
  try {
    const path = await realpath(resolve(root, requested.file));
    if (!path.startsWith(root + sep)) return `Attachment \`${requested.file}\` dropped: outside the artifacts directory.`;
    const info = await stat(path);
    if (!info.isFile()) return `Attachment \`${requested.file}\` dropped: not a regular file.`;
    if (info.size > MAX_BYTES) return `Attachment \`${requested.file}\` dropped: larger than 10 MB.`;
    return { path, caption: requested.caption, contentType };
  } catch {
    return `Attachment \`${requested.file}\` dropped: file not found.`;
  }
};

export const resolveAttachments = async (
  artifactsDir: string,
  requested: BrainResult["attachments"],
): Promise<{ accepted: ResolvedAttachment[]; notes: string[] }> => {
  const root = await realpath(artifactsDir);
  const accepted: ResolvedAttachment[] = [];
  const notes: string[] = [];
  for (const item of requested) {
    const outcome = await resolveOne(root, item);
    if (typeof outcome === "string") notes.push(outcome);
    else accepted.push(outcome);
  }
  return { accepted, notes };
};
