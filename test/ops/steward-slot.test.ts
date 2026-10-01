import { chmod, copyFile, mkdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { execa } from "execa";
import { removeDir, tmpDir } from "../workspace/helpers.js";

const HELPER = resolve("ops/steward-slot");
const COMPOSE = "/etc/ticket-steward/slots/compose.yml";
const MALFORMED = "steward-slot: expected one request line of at most 64 bytes";

let root: string;
let log: string;

beforeEach(async () => {
  root = await tmpDir();
  await mkdir(join(root, "bin"));
  await copyFile(resolve("test/ops/fakeDocker.sh"), join(root, "bin", "docker"));
  await chmod(join(root, "bin", "docker"), 0o755);
  log = join(root, "docker.log");
});

afterEach(async () => {
  await removeDir(root);
});

const helperEnv = (env: Record<string, string>): Record<string, string> => ({ PATH: `${join(root, "bin")}:${process.env.PATH ?? ""}`, FAKE_DOCKER_LOG: log, ...env });

/** CLI mode, the way an operator runs it as root. */
const slot = (args: string[], env: Record<string, string> = {}) => execa("bash", [HELPER, ...args], { env: helperEnv(env), extendEnv: false, reject: false });

/** Socket mode, the way steward-slot@.service runs it: the connection is stdin and stdout. */
const request = (input: string, env: Record<string, string> = {}) => execa("bash", [HELPER, "--socket"], { env: helperEnv(env), extendEnv: false, reject: false, input });

const dockerCalls = async (): Promise<string[]> => (await readFile(log, "utf8").catch(() => "")).split("\n").filter((line) => line !== "");

describe("steward-slot", () => {
  it.each([
    { args: [] },
    { args: ["start", "1"] },
    { args: ["up"] },
    { args: ["up", "0"] },
    { args: ["up", "10"] },
    { args: ["up", "01"] },
    { args: ["up", "1;rm"] },
    { args: ["up", "1", "2"] },
    { args: ["down", "-1"] },
    { args: ["check", "1"] },
    { args: ["--socket", "up"] },
  ])("rejects $args with exit 2 and a usage line, without running docker", async ({ args }) => {
    const result = await slot(args);
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("usage: steward-slot");
    expect(await dockerCalls()).toEqual([]);
  });

  it("prints the slot's ports as one JSON line, without running docker", async () => {
    expect((await slot(["ports", "1"])).stdout).toBe('{"postgres":15132,"redis":16179,"rabbitmq":15172}');
    expect((await slot(["ports", "9"])).stdout).toBe('{"postgres":15932,"redis":16979,"rabbitmq":15972}');
    expect(await dockerCalls()).toEqual([]);
  });

  it("brings project steward-slot-<n> up and waits, with the slot's ports exported", async () => {
    expect((await slot(["up", "2"])).exitCode).toBe(0);
    expect(await dockerCalls()).toEqual([`compose -p steward-slot-2 -f ${COMPOSE} up -d --wait --wait-timeout 120|15232|16279|15272`]);
  });

  it("brings the project down with its volumes and orphans", async () => {
    expect((await slot(["down", "3"])).exitCode).toBe(0);
    expect(await dockerCalls()).toEqual([`compose -p steward-slot-3 -f ${COMPOSE} down --volumes --remove-orphans --timeout 10|15332|16379|15372`]);
  });

  it("lists the project's running containers", async () => {
    expect((await slot(["status", "1"])).exitCode).toBe(0);
    expect(await dockerCalls()).toEqual(["ps --filter label=com.docker.compose.project=steward-slot-1 --format {{.Names}} {{.Status}}|15132|16179|15172"]);
  });

  it("check prints ok when the compose file parses and every image is present", async () => {
    const result = await slot(["check"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("ok");
    expect(await dockerCalls()).toEqual([
      `compose -f ${COMPOSE} config --quiet|15132|16179|15172`,
      `compose -f ${COMPOSE} config --images|15132|16179|15172`,
      "image inspect timescale/timescaledb-ha:pg17-ts2.27-all|15132|16179|15172",
      "image inspect redis:7-alpine|15132|16179|15172",
      "image inspect rabbitmq:4.2.0-management|15132|16179|15172",
    ]);
  });

  it("check lets compose's real error through when the file does not parse", async () => {
    const result = await slot(["check"], { FAKE_DOCKER_CONFIG_ERROR: "yaml: line 3: mapping values are not allowed" });
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe(`compose file ${COMPOSE} does not parse`);
    expect(result.stderr).toBe("yaml: line 3: mapping values are not allowed");
  });

  it("check names a missing image and exits 1", async () => {
    const result = await slot(["check"], { FAKE_DOCKER_MISSING: "redis:7-alpine" });
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe("image redis:7-alpine is not pulled");
  });
});

describe("steward-slot --socket", () => {
  it("runs the one request line and ends with its exit status", async () => {
    const result = await request("up 2\n");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("exit 0");
    expect(await dockerCalls()).toEqual([`compose -p steward-slot-2 -f ${COMPOSE} up -d --wait --wait-timeout 120|15232|16279|15272`]);
  });

  it("sends the command's output before the exit line", async () => {
    expect((await request("ports 1\n")).stdout).toBe('{"postgres":15132,"redis":16179,"rabbitmq":15172}\nexit 0');
  });

  it("reports a failing command's status in-band and exits 0 itself, so the unit never fails", async () => {
    const result = await request("check\n", { FAKE_DOCKER_MISSING: "redis:7-alpine" });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("image redis:7-alpine is not pulled\nexit 1");
  });

  it.each([{ input: "up 1;rm\n" }, { input: "up 01\n" }, { input: "up 1 2\n" }, { input: "--socket\n" }, { input: "\n" }])(
    "answers $input with a usage line and exit 2, without running docker",
    async ({ input }) => {
      const result = await request(input);
      expect(result.stdout).toContain("usage: steward-slot");
      expect(result.stdout.endsWith("\nexit 2")).toBe(true);
      expect(await dockerCalls()).toEqual([]);
    },
  );

  it("rejects a line over 64 bytes made of multibyte characters, whatever the locale", async () => {
    const result = await request(`${"é".repeat(40)}\n`, { LC_ALL: "C.UTF-8" });
    expect(result.stdout).toBe(`${MALFORMED}\nexit 2`);
    expect(await dockerCalls()).toEqual([]);
  });

  it("exits 0 when the client has already gone, instead of dying on SIGPIPE", async () => {
    const script = `{ sleep 0.3; echo 'ports 1'; } | bash ${HELPER} --socket | true; echo "\${PIPESTATUS[1]}"`;
    const result = await execa("bash", ["-c", script], { env: helperEnv({}), extendEnv: false, reject: false });
    expect(result.stdout).toBe("0");
  });

  it.each([{ input: "up 1" }, { input: `${"x".repeat(100)}\n` }, { input: "" }])("answers a request that is not one short line with exit 2", async ({ input }) => {
    expect((await request(input)).stdout).toBe(`${MALFORMED}\nexit 2`);
    expect(await dockerCalls()).toEqual([]);
  });
});

describe("slot ops files", () => {
  it("publishes every port on 127.0.0.1 only, keeps data on tmpfs, and pins the images and credentials", async () => {
    const compose = await readFile(resolve("ops/slots-compose.yml"), "utf8");
    expect(compose.split("\n").filter((line) => line.includes("${STEWARD_SLOT_")).map((line) => line.trim())).toEqual([
      '- "127.0.0.1:${STEWARD_SLOT_POSTGRES_PORT:?run through steward-slot}:5432"',
      '- "127.0.0.1:${STEWARD_SLOT_REDIS_PORT:?run through steward-slot}:6379"',
      '- "127.0.0.1:${STEWARD_SLOT_RABBITMQ_PORT:?run through steward-slot}:5672"',
    ]);
    for (const image of ["timescale/timescaledb-ha:pg17-ts2.27-all", "redis:7-alpine", "rabbitmq:4.2.0-management"]) expect(compose).toContain(`image: ${image}`);
    expect(compose.match(/pull_policy: missing/g)).toHaveLength(3);
    expect(compose.match(/tmpfs:/g)).toHaveLength(3);
    expect(compose.match(/healthcheck:/g)).toHaveLength(3);
    expect(compose).not.toMatch(/^volumes:/m);
    expect(compose).toContain("POSTGRES_USER: postgres");
    expect(compose).toContain("POSTGRES_PASSWORD: steward-slot");
    expect(compose).toContain("RABBITMQ_DEFAULT_USER: steward");
    expect(compose).toContain("RABBITMQ_DEFAULT_PASS: steward-slot");
    expect(compose).toContain('command: ["redis-server", "--save", "", "--appendonly", "no"]');
  });

  it("creates both databases and the timescaledb extension", async () => {
    expect(await readFile(resolve("ops/slots-init/01-databases.sql"), "utf8")).toBe(
      [
        "-- Databases for one worker slot; the Postgres entrypoint runs this once, on the slot's fresh data directory.",
        "CREATE DATABASE concentrate;",
        "CREATE DATABASE concentrate_tg;",
        "\\connect concentrate_tg",
        "CREATE EXTENSION IF NOT EXISTS timescaledb;",
        "",
      ].join("\n"),
    );
  });

  it("socket-activates one root helper per connection, reachable by group steward only", async () => {
    const socket = (await readFile(resolve("ops/steward-slot.socket"), "utf8")).split("\n");
    for (const line of ["ListenStream=/run/steward-slot.sock", "SocketUser=root", "SocketGroup=steward", "SocketMode=0660", "Accept=yes"]) expect(socket).toContain(line);
    const service = await readFile(resolve("ops/steward-slot@.service"), "utf8");
    for (const line of ["ExecStart=/usr/local/sbin/steward-slot --socket", "StandardInput=socket", "StandardOutput=socket", "RuntimeMaxSec=300", "Wants=docker.service", "After=docker.service"]) expect(service.split("\n")).toContain(line);
    expect(service).not.toMatch(/^User=/m);
  });
});
