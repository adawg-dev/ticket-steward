import { constants } from "node:fs";
import { lstat, mkdir, open, readdir, readFile, readlink, realpath, utimes, writeFile } from "node:fs/promises";
import { dirname, join, sep } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { GetObjectCommand, paginateListObjectsV2, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { AssumeRoleWithWebIdentityCommand, STSClient } from "@aws-sdk/client-sts";
import type { AwsCredentialIdentity, AwsCredentialIdentityProvider } from "@aws-sdk/types";
import { sessionProjectDir } from "../workspace/retention.js";

/** `CLAUDE_CONFIG_DIR` in a run pod, as on the Compose host, so stored sessions resume. */
export const SESSIONS_CONFIG_DIR = "/var/lib/ticket-steward/sessions";
export const SESSIONS_BUCKET = "steward-sessions";
/** Where the sessions containers' projected service-account token (audience `minio`) is mounted. */
export const MINIO_TOKEN_FILE = "/var/run/secrets/steward/minio/token";
export const SYNC_INTERVAL_SECONDS = 120;
/** MinIO ignores the region, but the SDK signs with one. */
const MINIO_REGION = "us-east-1";

export interface StoredObject {
  key: string;
  size: number;
  lastModified: Date;
}

/** The part of a bucket session sync uses, so tests can stand in for MinIO. */
export interface ObjectStore {
  list(prefix: string): Promise<StoredObject[]>;
  get(key: string): Promise<Uint8Array>;
  /** A whole-object put. */
  put(key: string, body: Uint8Array): Promise<void>;
}

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

/** Where one ticket's transcripts live in the bucket: `sessions/<identifier>/`. */
export const sessionObjectPrefix = (identifier: string): string => {
  if (!IDENTIFIER.test(identifier)) throw new Error(`not a ticket identifier: ${JSON.stringify(identifier)}`);
  return `sessions/${identifier}/`;
};

/** The folder Claude Code keeps sessions started in `worktreePath` in; the only one sync touches. */
export const sessionFolder = (configDir: string, worktreePath: string): string => join(configDir, "projects", sessionProjectDir(worktreePath));

/**
 * Temporary MinIO credentials from MinIO's STS `AssumeRoleWithWebIdentity`, signed in with the projected
 * service-account token in `tokenFile`, so no access key is stored anywhere. The token is re-read on every call, as
 * the kubelet rotates it. Errors name the file, never the token.
 */
export const minioCredentials = async (p: { endpoint: string; tokenFile: string; durationSeconds: 3600; roleArn?: string }): Promise<AwsCredentialIdentity> => {
  let token: string;
  try {
    token = (await readFile(p.tokenFile, "utf8")).trim();
  } catch (error) {
    throw new Error(`MinIO STS: cannot read the token file ${p.tokenFile}: ${error instanceof Error && "code" in error ? String(error.code) : "unreadable"}`, { cause: error });
  }
  if (token === "") throw new Error(`MinIO STS: the token file ${p.tokenFile} is empty`);
  const sts = new STSClient({ endpoint: p.endpoint, region: MINIO_REGION });
  let credentials;
  try {
    ({ Credentials: credentials } = await sts.send(
      new AssumeRoleWithWebIdentityCommand({ RoleArn: p.roleArn, RoleSessionName: "steward-sessions", WebIdentityToken: token, DurationSeconds: p.durationSeconds }),
    ));
  } catch (error) {
    throw new Error(`MinIO STS: AssumeRoleWithWebIdentity at ${p.endpoint} with the token in ${p.tokenFile} failed: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
  } finally {
    sts.destroy();
  }
  const { AccessKeyId: accessKeyId, SecretAccessKey: secretAccessKey, SessionToken: sessionToken, Expiration: expiration } = credentials ?? {};
  if (accessKeyId === undefined || secretAccessKey === undefined || sessionToken === undefined || expiration === undefined) {
    throw new Error(`MinIO STS: AssumeRoleWithWebIdentity at ${p.endpoint} returned incomplete credentials`);
  }
  return { accessKeyId, secretAccessKey, sessionToken, expiration };
};

/**
 * What MinIO answers a request signed with STS credentials it no longer honours. Its session tokens are signed with the
 * root key, which the MinIO image makes new on every start, so a MinIO restart turns every outstanding credential into
 * one of these until it is replaced.
 */
const STALE_CREDENTIAL_CODES = new Set(["InvalidAccessKeyId", "InvalidTokenId", "InvalidToken", "ExpiredToken", "AccessDenied"]);
const staleCredentials = (error: unknown): boolean => error instanceof Error && STALE_CREDENTIAL_CODES.has(error.name);

/**
 * One bucket on MinIO, path-style. `credentials` is a provider: the SDK keeps what it returns until five minutes
 * before its expiration, then asks again. A request MinIO turns away for its credentials is retried once on a new
 * client, which asks the provider afresh (a new STS sign-in), so a MinIO restart costs a sign-in, not the uploads
 * until the old credentials expire.
 */
export const s3ObjectStore = (p: { endpoint: string; bucket: string; credentials: AwsCredentialIdentityProvider }): ObjectStore => {
  const newClient = (): S3Client =>
    new S3Client({
      endpoint: p.endpoint,
      region: MINIO_REGION,
      forcePathStyle: true,
      credentials: p.credentials,
      // Whole-file puts with a known length; no aws-chunked trailers.
      requestChecksumCalculation: "WHEN_REQUIRED",
      responseChecksumValidation: "WHEN_REQUIRED",
    });
  let client = newClient();
  const where = (key: string): string => `s3://${p.bucket}/${key}`;
  const wrap = async <T>(what: string, run: (client: S3Client) => Promise<T>): Promise<T> => {
    try {
      try {
        return await run(client);
      } catch (error) {
        if (!staleCredentials(error)) throw error;
        client.destroy();
        client = newClient();
        return await run(client);
      }
    } catch (error) {
      throw new Error(`MinIO: ${what} failed: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
    }
  };
  return {
    list: (prefix) =>
      wrap(`listing ${where(prefix)}`, async (client) => {
        const objects: StoredObject[] = [];
        for await (const page of paginateListObjectsV2({ client }, { Bucket: p.bucket, Prefix: prefix })) {
          for (const { Key: key, Size: size, LastModified: lastModified } of page.Contents ?? []) {
            if (key !== undefined && size !== undefined && lastModified !== undefined) objects.push({ key, size, lastModified });
          }
        }
        return objects;
      }),
    get: (key) =>
      wrap(`reading ${where(key)}`, async (client) => {
        const { Body: body } = await client.send(new GetObjectCommand({ Bucket: p.bucket, Key: key }));
        if (body === undefined) throw new Error("no body");
        return body.transformToByteArray();
      }),
    put: (key, body) =>
      wrap(`writing ${where(key)}`, async (client) => {
        await client.send(new PutObjectCommand({ Bucket: p.bucket, Key: key, Body: body, ContentLength: body.byteLength }));
      }),
  };
};

/** The local path, relative and `/`-separated, an object under `prefix` goes to; refuses one that would leave the folder. */
const relativeName = (prefix: string, key: string): string => {
  const name = key.slice(prefix.length);
  if (!key.startsWith(prefix) || name.split("/").some((part) => part === "" || part === "." || part === "..") || name.includes("\\")) {
    throw new Error(`refusing object ${JSON.stringify(key)}: its name leaves the session folder`);
  }
  return name;
};

/**
 * Downloads every object under the ticket's prefix into `folder`, which it creates (empty when there is nothing
 * stored: a first run). Each file's mtime is set to its object's LastModified, so a later push can tell it unchanged.
 */
export const pullSession = async (p: { store: ObjectStore; identifier: string; folder: string }): Promise<number> => {
  const prefix = sessionObjectPrefix(p.identifier);
  const objects = await p.store.list(prefix);
  const names = objects.map((object) => relativeName(prefix, object.key));
  await mkdir(p.folder, { recursive: true });
  for (const [i, object] of objects.entries()) {
    const target = join(p.folder, ...(names[i] ?? "").split("/"));
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, await p.store.get(object.key));
    await utimes(target, object.lastModified, object.lastModified);
  }
  return objects.length;
};

interface Stamp {
  size: number;
  mtimeMs: number;
}

const sameStamp = (a: Stamp, b: Stamp): boolean => a.size === b.size && Math.round(a.mtimeMs) === Math.round(b.mtimeMs);

/** Regular files under `root` by relative `/`-separated name; symlinks are skipped, a missing root is empty. */
const localFiles = async (root: string): Promise<Map<string, Stamp>> => {
  const files = new Map<string, Stamp>();
  let entries;
  try {
    entries = await readdir(root, { recursive: true, withFileTypes: true });
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return files;
    throw error;
  }
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const path = join(entry.parentPath, entry.name);
    const { size, mtimeMs } = await lstat(path);
    files.set(path.slice(root.length + 1).split(sep).join("/"), { size, mtimeMs });
  }
  return files;
};

/**
 * A session file's bytes, or null when it is no longer a regular file inside `root`. The agent writes in this folder
 * and this container holds the MinIO token, so a symlink (or a parent directory swapped for one) must not get some
 * other file uploaded: the final component is opened without following links, and on Linux the opened file's real
 * path must still lie under `root`'s.
 */
const readInside = async (root: string, name: string): Promise<Buffer | null> => {
  let handle;
  try {
    handle = await open(join(root, ...name.split("/")), constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    if (error instanceof Error && "code" in error && (error.code === "ELOOP" || error.code === "ENOENT")) return null;
    throw error;
  }
  try {
    const opened = await readlink(`/proc/self/fd/${handle.fd}`).catch(() => null);
    if (opened !== null && !opened.startsWith(`${await realpath(root)}${sep}`)) return null;
    if (!(await handle.stat()).isFile()) return null;
    return await handle.readFile();
  } finally {
    await handle.close();
  }
};

export interface PushResult {
  pushed: number;
  unchanged: number;
}

/** Uploads a ticket's session folder, sending only files whose size or mtime changed since it last sent them. */
export class SessionPusher {
  readonly prefix: string;
  private readonly sent = new Map<string, Stamp>();
  private seeded = false;

  constructor(private readonly p: { store: ObjectStore; identifier: string; folder: string }) {
    this.prefix = sessionObjectPrefix(p.identifier);
  }

  /**
   * Takes stored objects as already sent, as `pullSession` left them (size and mtime = LastModified). A failed
   * listing leaves nothing taken as sent, so the push sends everything.
   */
  async seed(): Promise<void> {
    this.seeded = true;
    for (const object of await this.p.store.list(this.prefix)) {
      if (!object.key.startsWith(this.prefix)) continue;
      this.sent.set(object.key.slice(this.prefix.length), { size: object.size, mtimeMs: object.lastModified.getTime() });
    }
  }

  async push(): Promise<PushResult> {
    if (!this.seeded) await this.seed();
    let pushed = 0;
    let unchanged = 0;
    for (const [name, stamp] of await localFiles(this.p.folder)) {
      const sent = this.sent.get(name);
      if (sent !== undefined && sameStamp(sent, stamp)) {
        unchanged += 1;
        continue;
      }
      // The stamp is from before the read: a file still growing differs next time and is sent again.
      const body = await readInside(this.p.folder, name);
      if (body === null) continue;
      await this.p.store.put(`${this.prefix}${name}`, body);
      this.sent.set(name, stamp);
      pushed += 1;
    }
    return { pushed, unchanged };
  }
}

/**
 * Pushes every `intervalMs` until `signal` aborts, then pushes once more and returns that final result (which throws
 * on failure). A failed periodic push is reported and retried on the next tick; a push already under way when the
 * signal comes finishes first.
 */
export const syncSession = async (p: { pusher: SessionPusher; intervalMs: number; signal: AbortSignal; onPush: (result: PushResult) => void; onError: (error: Error) => void }): Promise<PushResult> => {
  const report = (error: unknown): void => p.onError(error instanceof Error ? error : new Error(String(error)));
  try {
    await p.pusher.seed();
  } catch (error) {
    report(error);
  }
  while (!p.signal.aborted) {
    try {
      await sleep(p.intervalMs, undefined, { signal: p.signal });
    } catch {
      break;
    }
    try {
      p.onPush(await p.pusher.push());
    } catch (error) {
      report(error);
    }
  }
  return p.pusher.push();
};
