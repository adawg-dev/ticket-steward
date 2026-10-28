import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { httpCheckRunner } from "../../src/push/checks.js";

let server: Server;
let baseUrl: string;
let reply: { status: number; body: string };
const received: unknown[] = [];

beforeEach(async () => {
  received.length = 0;
  reply = { status: 200, body: JSON.stringify({ ok: true, tail: "$ pnpm lint\n" }) };
  server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk: Buffer) => (body += chunk.toString("utf8")));
    req.on("end", () => {
      received.push({ method: req.method, url: req.url, body: JSON.parse(body) as unknown });
      res.writeHead(reply.status, { "content-type": "application/json" }).end(reply.body);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe("httpCheckRunner", () => {
  it("asks the agent container's check endpoint and returns its answer", async () => {
    expect(await httpCheckRunner(baseUrl, 5_000).run(["pnpm lint"])).toEqual({ ok: true, tail: "$ pnpm lint\n" });
    expect(received).toEqual([{ method: "POST", url: "/checks", body: { commands: ["pnpm lint"] } }]);
  });

  it("passes with no checks, without asking", async () => {
    expect(await httpCheckRunner(baseUrl, 5_000).run([])).toEqual({ ok: true, tail: "" });
    expect(received).toEqual([]);
  });

  it("fails the checks when the endpoint errs or answers nonsense", async () => {
    reply = { status: 500, body: "{}" };
    expect(await httpCheckRunner(baseUrl, 5_000).run(["pnpm lint"])).toEqual({ ok: false, tail: "the agent's check endpoint answered 500" });
    reply = { status: 200, body: "not json" };
    expect(await httpCheckRunner(baseUrl, 5_000).run(["pnpm lint"])).toMatchObject({ ok: false });
    expect(await httpCheckRunner("http://127.0.0.1:1", 5_000).run(["pnpm lint"])).toMatchObject({ ok: false, tail: expect.stringContaining("failed") });
  });
});
