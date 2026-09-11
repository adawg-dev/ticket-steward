import { existsSync } from "node:fs";
import { join } from "node:path";

import { git, gitOrThrow } from "./git.js";

export class Mirror {
  constructor(
    readonly path: string,
    private readonly fetchUrlWithToken: string,
  ) {}

  static async init(path: string, fetchUrlWithToken: string): Promise<Mirror> {
    await gitOrThrow(["clone", "--quiet", "--mirror", fetchUrlWithToken, path]);
    await gitOrThrow(["config", "extensions.worktreeConfig", "true"], path);
    return new Mirror(path, fetchUrlWithToken);
  }

  async fetch(): Promise<void> {
    await gitOrThrow(["remote", "set-url", "origin", this.fetchUrlWithToken], this.path);
    await gitOrThrow(["fetch", "--quiet", "--prune", "origin"], this.path);
  }

  /** A mirror stores remote branches under refs/heads, so `origin/<branch>` resolves to the mirrored branch. */
  async resolveSha(ref: string): Promise<string> {
    const local = ref.replace(/^origin\//, "");
    return gitOrThrow(["rev-parse", "--verify", `${local}^{commit}`], this.path);
  }

  exists(): boolean {
    return existsSync(join(this.path, "HEAD")) && existsSync(join(this.path, "objects"));
  }

  async hasWorktreeConfigExtension(): Promise<boolean> {
    const result = await git(["config", "--get", "extensions.worktreeConfig"], this.path);
    return result.exitCode === 0 && result.stdout === "true";
  }
}

export const injectToken = (url: string, token: string | undefined): string => {
  if (token === undefined || token === "") return url;
  const parsed = new URL(url);
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return url;
  parsed.username = parsed.hostname === "github.com" ? "x-access-token" : "oauth2";
  parsed.password = token;
  return parsed.toString();
};
