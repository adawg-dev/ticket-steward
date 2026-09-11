import { spawn } from "node:child_process";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { execa } from "execa";

import { gitEnvRecord } from "../../src/workspace/git.js";

export const tmpDir = (): Promise<string> => mkdtemp(join(tmpdir(), "steward-test-"));

export const removeDir = (dir: string): Promise<void> => rm(dir, { recursive: true, force: true });

const gitIdentity = ["-c", "user.name=Test", "-c", "user.email=test@example.com"];

export const git = async (cwd: string, args: string[]): Promise<string> => {
  const { stdout } = await execa("git", [...gitIdentity, ...args], { cwd, env: gitEnvRecord(), extendEnv: false });
  return stdout.trim();
};

export const commitFile = async (repo: string, file: string, content: string): Promise<string> => {
  const full = join(repo, file);
  await mkdir(dirname(full), { recursive: true });
  await writeFile(full, content);
  await git(repo, ["add", "--", file]);
  await git(repo, ["commit", "-q", "-m", `add ${file}`]);
  return git(repo, ["rev-parse", "HEAD"]);
};

export const makeSourceRepo = async (root: string): Promise<{ repo: string; sha: string }> => {
  const repo = join(root, "source");
  await mkdir(repo);
  await git(repo, ["init", "-q", "-b", "main"]);
  const sha = await commitFile(repo, "README.md", "hello\n");
  return { repo, sha };
};

export interface GitHttpServer {
  /** Base URL; repositories under `root` are served at `<url>/<name>`. */
  url: string;
  /** The `Authorization` header of every request received, in order ("" when absent). */
  authorizations: string[];
  close(): Promise<void>;
}

const CGI_HEADER_END = "\r\n\r\n";

/** Bridges one HTTP request to `git http-backend` over CGI. */
const serveViaHttpBackend = (root: string, req: IncomingMessage, res: ServerResponse): void => {
  const url = new URL(req.url ?? "/", "http://localhost");
  const backend = spawn("git", ["http-backend"], {
    env: {
      ...gitEnvRecord(),
      GIT_PROJECT_ROOT: root,
      GIT_HTTP_EXPORT_ALL: "1",
      REQUEST_METHOD: req.method ?? "GET",
      PATH_INFO: url.pathname,
      QUERY_STRING: url.search.slice(1),
      REMOTE_ADDR: "127.0.0.1",
      CONTENT_TYPE: req.headers["content-type"] ?? "",
      HTTP_CONTENT_ENCODING: req.headers["content-encoding"] ?? "",
      GIT_PROTOCOL: String(req.headers["git-protocol"] ?? ""),
    },
  });
  req.pipe(backend.stdin);
  let head = Buffer.alloc(0);
  let headersDone = false;
  backend.stdout.on("data", (chunk: Buffer) => {
    if (headersDone) {
      res.write(chunk);
      return;
    }
    head = Buffer.concat([head, chunk]);
    const end = head.indexOf(CGI_HEADER_END);
    if (end === -1) return;
    for (const line of head.subarray(0, end).toString().split("\r\n")) {
      const [name, ...rest] = line.split(":");
      const value = rest.join(":").trim();
      if (name?.toLowerCase() === "status") res.statusCode = Number.parseInt(value, 10);
      else if (name !== undefined) res.setHeader(name, value);
    }
    headersDone = true;
    res.write(head.subarray(end + CGI_HEADER_END.length));
  });
  backend.stdout.on("end", () => res.end());
};

/** A smart-HTTP git server for the repositories under `root`, recording the Authorization header of each request. */
export const serveGitHttp = (root: string): Promise<GitHttpServer> =>
  new Promise((resolve) => {
    const authorizations: string[] = [];
    const server = createServer((req, res) => {
      authorizations.push(req.headers.authorization ?? "");
      serveViaHttpBackend(root, req, res);
    });
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      resolve({
        url: `http://127.0.0.1:${port}`,
        authorizations,
        close: () => new Promise((done) => server.close(() => done())),
      });
    });
  });
