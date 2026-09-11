import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";

import { git, gitOrThrow } from "./git.js";

export interface RemoteCredentials {
  /** The fetch URL with any embedded `user:password@` removed. */
  url: string;
  /** Git env that supplies the removed credentials as an `Authorization` header to one git process only; never persisted. */
  env: Record<string, string>;
}

/** Splits a tokenized URL (as produced by `injectToken`) into a plain URL and a per-process credential env. Non-URL sources pass through. */
export const splitCredentials = (fetchUrlWithToken: string): RemoteCredentials => {
  if (!/^https?:\/\//.test(fetchUrlWithToken)) return { url: fetchUrlWithToken, env: {} };
  const parsed = new URL(fetchUrlWithToken);
  if (parsed.username === "" && parsed.password === "") return { url: fetchUrlWithToken, env: {} };
  const basic = Buffer.from(`${decodeURIComponent(parsed.username)}:${decodeURIComponent(parsed.password)}`).toString("base64");
  parsed.username = "";
  parsed.password = "";
  return {
    url: parsed.toString(),
    env: {
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: `http.${parsed.origin}.extraHeader`,
      GIT_CONFIG_VALUE_0: `Authorization: Basic ${basic}`,
    },
  };
};

export class Mirror {
  private readonly remote: RemoteCredentials;

  constructor(
    readonly path: string,
    fetchUrlWithToken: string,
  ) {
    this.remote = splitCredentials(fetchUrlWithToken);
  }

  static async init(path: string, fetchUrlWithToken: string): Promise<Mirror> {
    const remote = splitCredentials(fetchUrlWithToken);
    await mkdir(path, { recursive: true, mode: 0o700 });
    await gitOrThrow(["clone", "--quiet", "--mirror", remote.url, path], undefined, remote.env);
    await gitOrThrow(["config", "extensions.worktreeConfig", "true"], path);
    return new Mirror(path, fetchUrlWithToken);
  }

  async fetch(): Promise<void> {
    await gitOrThrow(["remote", "set-url", "origin", this.remote.url], this.path);
    await gitOrThrow(["fetch", "--quiet", "--prune", "origin"], this.path, this.remote.env);
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
