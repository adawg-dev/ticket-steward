import { readFile } from "node:fs/promises";
import { z } from "zod";
import type { StewardConfig } from "../config/schema.js";
import { localGuard, type PushGuard } from "../push/service.js";

/** `render-overlay --guard-out`: every real value and every placeholder of the run's overlay. */
const GuardFile = z.array(z.string());

/**
 * The dir whose files, by relative path, the steward lays into the worktree. On Kubernetes that is the overlay template:
 * render-overlay writes each template file at the same relative path, and the Compose `overlayDir` is not in the pod.
 */
export const stewardOverlayDir = (config: Pick<StewardConfig, "runtime" | "workspace">): string =>
  config.runtime?.kind === "kubernetes" && config.workspace.overlayTemplateDir !== undefined ? config.workspace.overlayTemplateDir : config.workspace.overlayDir;

/**
 * The tools sidecar's push guard: the values in the run's guard file, real and placeholder alike, plus what the local guard
 * covers (the steward files and its own tokens). Read on every push, so a missing or malformed file refuses the push.
 */
export const toolsGuard =
  (p: { guardFile: string | null; overlayDir: string; skillsDir: string | undefined; secrets: Record<string, string | undefined> }): (() => Promise<PushGuard>) =>
  async () => {
    const local = await localGuard(p);
    if (p.guardFile === null) return local;
    const values = GuardFile.safeParse(JSON.parse(await readFile(p.guardFile, "utf8")));
    if (!values.success) throw new Error(`${p.guardFile} is not a JSON array of strings`);
    return { stewardFiles: local.stewardFiles, secrets: [...new Set([...local.secrets, ...values.data])] };
  };
