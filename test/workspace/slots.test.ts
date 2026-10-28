import { spawn } from "node:child_process";
import { chmod, copyFile, mkdir } from "node:fs/promises";
import { createServer, type Server } from "node:net";
import { join, resolve } from "node:path";
import { renderSlotEnv, SlotClient, SlotError, socketRunner } from "../../src/workspace/slots.js";
import { fakeSlotRunner } from "../fakes/fakeSlotRunner.js";
import { removeDir, tmpDir } from "./helpers.js";

const SETTINGS = { socket: "/run/steward-slot.sock", upTimeoutSeconds: 180 };

describe("SlotClient", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("parses the helper's ports JSON", async () => {
    const runner = fakeSlotRunner();
    expect(await new SlotClient(SETTINGS, runner.run).ports(2)).toEqual({ postgres: 15232, redis: 16279, rabbitmq: 17272 });
    expect(runner.calls).toEqual([["ports", "2"]]);
  });

  it("rejects ports output that is not the port JSON", async () => {
    const runner = fakeSlotRunner();
    runner.respond("ports", { stdout: "WARN docker is slow\n", output: "WARN docker is slow\n" });
    await expect(new SlotClient(SETTINGS, runner.run).ports(1)).rejects.toThrow("slot 1: ports printed no port JSON: WARN docker is slow");
  });

  it("starts with down, then up under the configured timeout, then reads the ports", async () => {
    const runner = fakeSlotRunner();
    expect(await new SlotClient(SETTINGS, runner.run).start(1)).toEqual({ postgres: 15132, redis: 16179, rabbitmq: 17172 });
    expect(runner.calls).toEqual([["down", "1"], ["up", "1"], ["ports", "1"]]);
    expect(runner.timeouts).toEqual([60_000, 180_000, 60_000]);
  });

  it("maps a failed up to the slot and the last 4 KB of the helper's output", async () => {
    const runner = fakeSlotRunner();
    runner.respond("up", { exitCode: 1, output: `${"x".repeat(5000)}\nError response from daemon: port is already allocated\n` });
    const failure = new SlotClient(SETTINGS, runner.run).start(2);
    await expect(failure).rejects.toBeInstanceOf(SlotError);
    await expect(failure).rejects.toSatisfy(
      (err: SlotError) => err.n === 2 && Buffer.byteLength(err.tail) === 4096 && err.tail.endsWith("port is already allocated\n[exit 1]") && err.message === `slot 2: ${err.tail}`,
    );
  });

  it("reports a hung up as timed out", async () => {
    const runner = fakeSlotRunner();
    runner.respond("up", { exitCode: 1, timedOut: true, output: "Container steward-slot-1-rabbitmq-1  Waiting\n" });
    await expect(new SlotClient(SETTINGS, runner.run).start(1)).rejects.toThrow("slot 1: Container steward-slot-1-rabbitmq-1  Waiting\n[timed out after 180 s]");
  });

  it("does not run up when the leading down fails, and passes the runner's reason through", async () => {
    const runner = fakeSlotRunner();
    const reason = "cannot reach the slot helper at /run/steward-slot.sock: connect ENOENT /run/steward-slot.sock";
    runner.respond("down", { exitCode: 1, output: reason });
    await expect(new SlotClient(SETTINGS, runner.run).start(1)).rejects.toThrow(`slot 1: ${reason}\n[exit 1]`);
    expect(runner.calls).toEqual([["down", "1"]]);
  });

  it("passes the signal to up and reports a canceled up as interrupted", async () => {
    const runner = fakeSlotRunner();
    runner.hang("up");
    const controller = new AbortController();
    const starting = new SlotClient(SETTINGS, runner.run).start(1, controller.signal);
    await vi.waitFor(() => expect(runner.calls).toContainEqual(["up", "1"]));
    controller.abort();
    await expect(starting).rejects.toThrow("slot 1: [interrupted]");
  });

  it("release brings down only a slot this client started, and only once", async () => {
    const runner = fakeSlotRunner();
    const client = new SlotClient(SETTINGS, runner.run);
    await client.release(1);
    expect(runner.calls).toEqual([]);
    await client.start(1);
    await client.release(1);
    await client.release(1);
    expect(runner.calls).toEqual([["down", "1"], ["up", "1"], ["ports", "1"], ["down", "1"]]);
  });

  it("logs a failed down instead of throwing", async () => {
    const runner = fakeSlotRunner();
    const client = new SlotClient(SETTINGS, runner.run);
    await client.start(1);
    runner.respond("down", { exitCode: 1, output: "Cannot connect to the Docker daemon\n" });
    await expect(client.release(1)).resolves.toBeUndefined();
    expect(await client.down(2)).toBe(false);
  });

  it("status returns the running containers; check is ok only for exit 0 and a last line ok", async () => {
    const runner = fakeSlotRunner();
    const client = new SlotClient(SETTINGS, runner.run);
    runner.respond("status", { stdout: "steward-slot-1-postgres-1 Up 2 minutes\n" });
    expect(await client.status(1)).toBe("steward-slot-1-postgres-1 Up 2 minutes");
    expect(await client.check()).toEqual({ ok: true, output: "ok" });
    runner.respond("check", { exitCode: 1, stdout: "image redis:7-alpine is not pulled\n", output: "image redis:7-alpine is not pulled\n" });
    expect(await client.check()).toEqual({ ok: false, output: "image redis:7-alpine is not pulled" });
  });
});

describe("renderSlotEnv", () => {
  it("renders every template, with or without spaces in the braces, and keeps null", () => {
    const slot = { n: 1, appPort: 4101, ports: { postgres: 15132, redis: 16179, rabbitmq: 17172 } };
    expect(
      renderSlotEnv(
        {
          DB_PORT: "{{postgres}}",
          TG_CONN_STR: "postgres://postgres:steward-slot@localhost:{{ postgres }}/concentrate_tg",
          REDIS_URL: "redis://localhost:{{redis}}",
          RABBITMQ_URL: "amqp://steward:steward-slot@localhost:{{rabbitmq}}",
          BASE_URL: "http://localhost:{{app}}",
          DB_HOST: "localhost",
          REDIS_CLUSTER_NODES: null,
        },
        slot,
      ),
    ).toEqual({
      DB_PORT: "15132",
      TG_CONN_STR: "postgres://postgres:steward-slot@localhost:15132/concentrate_tg",
      REDIS_URL: "redis://localhost:16179",
      RABBITMQ_URL: "amqp://steward:steward-slot@localhost:17172",
      BASE_URL: "http://localhost:4101",
      DB_HOST: "localhost",
      REDIS_CLUSTER_NODES: null,
    });
  });
});

describe("socketRunner", () => {
  let root: string;
  let socketPath: string;
  let server: Server | null;
  let requests: string[];

  beforeEach(async () => {
    root = await tmpDir();
    socketPath = join(root, "slot.sock");
    server = null;
    requests = [];
  });

  afterEach(async () => {
    const listening = server;
    if (listening !== null) await new Promise<void>((done) => listening.close(() => done()));
    await removeDir(root);
  });

  /** Stands in for systemd and the helper: answers each request line with `reply(line)`, or never answers when `reply` is null. */
  const serve = (reply: ((request: string) => string) | null): Promise<void> =>
    new Promise((ready) => {
      const listening = createServer((connection) => {
        connection.setEncoding("utf8");
        connection.on("error", () => undefined);
        let received = "";
        connection.on("data", (chunk: Buffer | string) => {
          received += String(chunk);
          if (!received.endsWith("\n")) return;
          requests.push(received);
          if (reply !== null) connection.end(reply(received));
        });
      });
      server = listening;
      listening.listen(socketPath, () => ready());
    });

  it("sends one request line and returns the output before the exit line", async () => {
    await serve(() => '{"postgres":15132,"redis":16179,"rabbitmq":17172}\nexit 0\n');
    const result = await socketRunner(socketPath)(["ports", "1"], { timeoutMs: 5_000 });
    expect(requests).toEqual(["ports 1\n"]);
    const body = '{"postgres":15132,"redis":16179,"rabbitmq":17172}\n';
    expect(result).toEqual({ exitCode: 0, stdout: body, output: body, timedOut: false, canceled: false });
  });

  it("returns a non-zero exit status with the command's output", async () => {
    await serve(() => "Error response from daemon: port is already allocated\nexit 1\n");
    const result = await socketRunner(socketPath)(["up", "1"], { timeoutMs: 5_000 });
    expect(result).toMatchObject({ exitCode: 1, output: "Error response from daemon: port is already allocated\n", timedOut: false, canceled: false });
  });

  it("fails a reply without an exit line", async () => {
    await serve(() => "Container steward-slot-1-postgres-1  Starting\n");
    const result = await socketRunner(socketPath)(["up", "1"], { timeoutMs: 5_000 });
    expect(result).toMatchObject({ exitCode: 1, output: "Container steward-slot-1-postgres-1  Starting\nhelper closed without an exit status" });
  });

  it("gives up after the timeout", async () => {
    await serve(null);
    const result = await socketRunner(socketPath)(["up", "1"], { timeoutMs: 100 });
    expect(result).toMatchObject({ exitCode: 1, timedOut: true, canceled: false });
  });

  it("gives up when the signal aborts", async () => {
    await serve(null);
    const controller = new AbortController();
    const running = socketRunner(socketPath)(["up", "1"], { timeoutMs: 5_000, signal: controller.signal });
    await vi.waitFor(() => expect(requests).toEqual(["up 1\n"]));
    controller.abort();
    expect(await running).toMatchObject({ exitCode: 1, timedOut: false, canceled: true });
  });

  it("names the socket when nothing listens there", async () => {
    const result = await socketRunner(socketPath)(["check"], { timeoutMs: 5_000 });
    expect(result.exitCode).toBe(1);
    expect(result.output).toContain(`cannot reach the slot helper at ${socketPath}: `);
    expect(result.output).toContain("ENOENT");
  });

  it("speaks the real helper's socket mode (a stand-in for systemd's Accept=yes)", async () => {
    await mkdir(join(root, "bin"));
    await copyFile(resolve("test/ops/fakeDocker.sh"), join(root, "bin", "docker"));
    await chmod(join(root, "bin", "docker"), 0o755);
    const env = { PATH: `${join(root, "bin")}:${process.env.PATH ?? ""}`, FAKE_DOCKER_LOG: join(root, "docker.log") };
    const listening = createServer((connection) => {
      const helper = spawn("bash", [resolve("ops/steward-slot"), "--socket"], { env, stdio: ["pipe", "pipe", "inherit"] });
      connection.on("error", () => undefined);
      helper.stdin.on("error", () => undefined);
      connection.pipe(helper.stdin);
      helper.stdout.pipe(connection);
    });
    server = listening;
    await new Promise<void>((ready) => listening.listen(socketPath, () => ready()));
    const run = socketRunner(socketPath);

    const body = '{"postgres":15232,"redis":16279,"rabbitmq":17272}\n';
    expect(await run(["ports", "2"], { timeoutMs: 5_000 })).toEqual({ exitCode: 0, stdout: body, output: body, timedOut: false, canceled: false });
    expect((await run(["up", "01"], { timeoutMs: 5_000 })).exitCode).toBe(2);
  });
});
