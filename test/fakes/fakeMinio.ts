import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { ObjectStore, StoredObject } from "../../src/sessions/store.js";

/** An in-memory bucket behind the sessions' ObjectStore interface. */
export class MemoryObjectStore implements ObjectStore {
  readonly objects = new Map<string, { body: Uint8Array; lastModified: Date }>();
  /** Every key put, in order. */
  readonly puts: string[] = [];

  async list(prefix: string): Promise<StoredObject[]> {
    return [...this.objects.entries()]
      .filter(([key]) => key.startsWith(prefix))
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, object]) => ({ key, size: object.body.byteLength, lastModified: object.lastModified }));
  }

  async get(key: string): Promise<Uint8Array> {
    const object = this.objects.get(key);
    if (object === undefined) throw new Error(`no object ${key}`);
    return object.body;
  }

  async put(key: string, body: Uint8Array): Promise<void> {
    this.puts.push(key);
    this.objects.set(key, { body: Uint8Array.from(body), lastModified: new Date() });
  }

  text(key: string): string | undefined {
    const object = this.objects.get(key);
    return object === undefined ? undefined : Buffer.from(object.body).toString("utf8");
  }
}

export const FAKE_ACCESS_KEY = "FAKEMINIOACCESSKEY";
const FAKE_SECRET_KEY = "fake-minio-secret-key";
const FAKE_SESSION_TOKEN = "fake-minio-session-token";

export interface FakeMinio {
  endpoint: string;
  store: MemoryObjectStore;
  /** Every STS AssumeRoleWithWebIdentity call's form fields. */
  stsCalls: Record<string, string>[];
  /** S3 requests turned away for missing or wrong credentials. */
  rejected: string[];
  close: () => Promise<void>;
}

const escapeXml = (text: string): string => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

const xml = (res: ServerResponse, status: number, body: string): void => {
  res.writeHead(status, { "content-type": "application/xml" });
  res.end(`<?xml version="1.0" encoding="UTF-8"?>\n${body}`);
};

const s3Error = (res: ServerResponse, status: number, code: string): void => xml(res, status, `<Error><Code>${code}</Code><Message>${code}</Message></Error>`);

/**
 * MinIO as the sync sidecar sees it, over HTTP: STS `AssumeRoleWithWebIdentity` (accepting only `token`) and path-style
 * S3 ListObjectsV2, GetObject and PutObject on one bucket, which take only the credentials STS handed out.
 */
export const startFakeMinio = async (p: { bucket: string; token: string }): Promise<FakeMinio> => {
  const store = new MemoryObjectStore();
  const stsCalls: Record<string, string>[] = [];
  const rejected: string[] = [];

  const sts = (body: string, res: ServerResponse): void => {
    const form = Object.fromEntries(new URLSearchParams(body));
    if (form.Action !== "AssumeRoleWithWebIdentity") return s3Error(res, 400, "InvalidAction");
    stsCalls.push(form);
    if (form.WebIdentityToken !== p.token) {
      return xml(res, 400, '<ErrorResponse><Error><Type>Sender</Type><Code>InvalidIdentityToken</Code><Message>token rejected</Message></Error></ErrorResponse>');
    }
    const expiration = new Date(Date.now() + Number(form.DurationSeconds ?? "3600") * 1000).toISOString();
    xml(
      res,
      200,
      `<AssumeRoleWithWebIdentityResponse xmlns="https://sts.amazonaws.com/doc/2011-06-15/"><AssumeRoleWithWebIdentityResult><Credentials>` +
        `<AccessKeyId>${FAKE_ACCESS_KEY}</AccessKeyId><SecretAccessKey>${FAKE_SECRET_KEY}</SecretAccessKey>` +
        `<SessionToken>${FAKE_SESSION_TOKEN}</SessionToken><Expiration>${expiration}</Expiration>` +
        `</Credentials></AssumeRoleWithWebIdentityResult></AssumeRoleWithWebIdentityResponse>`,
    );
  };

  const s3 = async (req: IncomingMessage, url: URL, body: Buffer, res: ServerResponse): Promise<void> => {
    const authorization = req.headers.authorization ?? "";
    if (!authorization.includes(`Credential=${FAKE_ACCESS_KEY}/`) || req.headers["x-amz-security-token"] !== FAKE_SESSION_TOKEN) {
      rejected.push(`${req.method ?? ""} ${url.pathname}`);
      return s3Error(res, 403, "AccessDenied");
    }
    const [, bucket = "", ...rest] = url.pathname.split("/");
    if (bucket !== p.bucket) return s3Error(res, 404, "NoSuchBucket");
    const key = rest.map(decodeURIComponent).join("/");
    if (req.method === "GET" && key === "" && url.searchParams.get("list-type") === "2") {
      const objects = await store.list(url.searchParams.get("prefix") ?? "");
      const contents = objects
        .map((o) => `<Contents><Key>${escapeXml(o.key)}</Key><Size>${o.size}</Size><LastModified>${o.lastModified.toISOString()}</LastModified><ETag>"e"</ETag></Contents>`)
        .join("");
      return xml(res, 200, `<ListBucketResult><Name>${p.bucket}</Name><KeyCount>${objects.length}</KeyCount><IsTruncated>false</IsTruncated>${contents}</ListBucketResult>`);
    }
    if (req.method === "GET" && key !== "") {
      const object = store.objects.get(key);
      if (object === undefined) return s3Error(res, 404, "NoSuchKey");
      res.writeHead(200, { "content-type": "application/octet-stream", "content-length": object.body.byteLength, "last-modified": object.lastModified.toUTCString() });
      return void res.end(object.body);
    }
    if (req.method === "PUT" && key !== "") {
      await store.put(key, body);
      res.writeHead(200, { etag: '"e"' });
      return void res.end();
    }
    s3Error(res, 405, "MethodNotAllowed");
  };

  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const body = Buffer.concat(chunks);
      const url = new URL(req.url ?? "/", "http://fake-minio");
      if (req.method === "POST" && url.pathname === "/") return sts(body.toString("utf8"), res);
      void s3(req, url, body, res);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    endpoint: `http://127.0.0.1:${port}`,
    store,
    stsCalls,
    rejected,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
};
