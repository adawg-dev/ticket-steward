import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { PushTarget } from "../../src/push/target.js";
import { httpLedger } from "../../src/tools/httpLedger.js";

const TOKEN = "tools-token-value";

const target: PushTarget = {
  jobId: 7,
  worktreePath: "/var/lib/ticket-steward/work/ticket-API-1",
  identifier: "API-1",
  issueId: "issue-1",
  title: "Adapter drops the last chunk",
  mode: "create",
  branch: null,
  baseSha: "b".repeat(40),
  loopId: null,
  port: 3000,
};

type Seen = { method: string; url: string; authorization: string | undefined; body: unknown };

let server: Server;
let baseUrl: string;
let seen: Seen[];
let answer: (seen: Seen) => { status: number; body?: unknown };

const readBody = async (req: IncomingMessage): Promise<unknown> => {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk as Uint8Array));
  const text = Buffer.concat(chunks).toString("utf8");
  return text === "" ? null : (JSON.parse(text) as unknown);
};

beforeEach(async () => {
  seen = [];
  answer = () => ({ status: 204 });
  server = createServer((req: IncomingMessage, res: ServerResponse) => {
    void readBody(req).then((body) => {
      const request = { method: req.method ?? "", url: req.url ?? "", authorization: req.headers.authorization, body };
      seen.push(request);
      const { status, body: out } = answer(request);
      res.writeHead(status, { "content-type": "application/json" });
      res.end(out === undefined ? "" : JSON.stringify(out));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe("httpLedger", () => {
  it("calls the run's push routes with its token", async () => {
    const ledger = httpLedger({ baseUrl, runId: "run-1", token: TOKEN });
    answer = ({ url }) => {
      if (url.endsWith("/push/start")) return { status: 200, body: { kind: "fastForward", branch: "fix/API-1-x", base: "c".repeat(40) } };
      if (url.endsWith("/ticket")) return { status: 200, body: { title: "Adapter", closed: null } };
      if (url.endsWith("/push/record")) return { status: 200, body: { id: 12 } };
      return { status: 204 };
    };

    expect(await ledger.start(target, () => Promise.resolve(null))).toEqual({ kind: "fastForward", branch: "fix/API-1-x", base: "c".repeat(40) });
    expect(await ledger.ticket(target)).toEqual({ title: "Adapter", closed: null });
    expect(await ledger.record(target, { branch: "fix/API-1-x", sha: "d".repeat(40), previousSha: null, note: "first" })).toEqual({ id: 12 });
    await ledger.landed(target, 12, "d".repeat(40));
    await ledger.revert(target, 12);

    expect(seen.map(({ method, url }) => `${method} ${url}`)).toEqual([
      "POST /internal/runs/run-1/push/start",
      "GET /internal/runs/run-1/ticket",
      "POST /internal/runs/run-1/push/record",
      "POST /internal/runs/run-1/push/12/landed",
      "POST /internal/runs/run-1/push/12/revert",
    ]);
    expect(seen.every(({ authorization }) => authorization === `Bearer ${TOKEN}`)).toBe(true);
    expect(seen[2]?.body).toEqual({ branch: "fix/API-1-x", sha: "d".repeat(40), previousSha: null, note: "first" });
    expect(seen[3]?.body).toEqual({ sha: "d".repeat(40) });
  });

  it("surfaces a 401 as the run's push token being rejected", async () => {
    answer = () => ({ status: 401, body: { error: "unauthorized" } });
    const ledger = httpLedger({ baseUrl, runId: "run-1", token: TOKEN });

    await expect(ledger.ticket(target)).rejects.toThrow("the run's push token was rejected");
  });

  it("rejects an answer that is not the expected shape, naming the route", async () => {
    answer = () => ({ status: 200, body: { kind: "sideways" } });
    const ledger = httpLedger({ baseUrl, runId: "run-1", token: TOKEN });

    await expect(ledger.start(target, () => Promise.resolve(null))).rejects.toThrow("push/start");
  });
});
