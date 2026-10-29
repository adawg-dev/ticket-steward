import { spawn } from "node:child_process";
import { appendFileSync } from "node:fs";
import { appendFile, mkdir, mkdtemp, readdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { buildProgram } from "../../src/cli/program.js";
import { minioCredentials, pullSession, s3ObjectStore, sessionFolder, sessionObjectPrefix, SessionPusher, syncSession, type ObjectStore, type PushResult } from "../../src/sessions/store.js";
import { ExitSignal, makeContext } from "../cli/helpers.js";
import { FAKE_ACCESS_KEY, MemoryObjectStore, startFakeMinio, type FakeMinio } from "../fakes/fakeMinio.js";

// tsx as a loader, not its CLI: one process, as in the pod, which gets the SIGTERM itself.
const tsxLoader = pathToFileURL(resolve("node_modules/tsx/dist/loader.mjs")).href;
const WORKTREE = "/var/lib/ticket-steward/work/ticket-ENG-7";
const TOKEN = "k3s-projected-token-for-minio";

let dir: string;
let minio: FakeMinio | null = null;

const fake = (): FakeMinio => {
  if (minio === null) throw new Error("fake MinIO not started");
  return minio;
};

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "steward-sessions-"));
});

afterEach(async () => {
  await minio?.close();
  minio = null;
  await rm(dir, { recursive: true, force: true });
});

const writeIn = async (path: string, text: string): Promise<void> => {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, text);
};

/** Every file under `root`, relative and sorted. */
const listTree = async (root: string): Promise<string[]> => (await readdir(root, { recursive: true, withFileTypes: true })).filter((e) => e.isFile()).map((e) => join(e.parentPath, e.name).slice(root.length + 1)).sort();

const cli = (configDir: string, store: ObjectStore, command: "pull" | "push", identifier = "ENG-7") => {
  const test = makeContext({ factories: { objectStore: store } });
  const run = buildProgram(test.ctx).parseAsync(["node", "steward", "sessions", command, "--identifier", identifier, "--worktree", WORKTREE, "--config-dir", configDir, "--endpoint", "http://minio.invalid:9000"]);
  return { test, run };
};

describe("session object names", () => {
  it("keeps each ticket's transcripts under sessions/<KEY>/", () => {
    expect(sessionObjectPrefix("ENG-7")).toBe("sessions/ENG-7/");
    expect(sessionFolder("/var/lib/ticket-steward/sessions", WORKTREE)).toBe("/var/lib/ticket-steward/sessions/projects/-var-lib-ticket-steward-work-ticket-ENG-7");
  });

  it.each(["", "../ENG-7", "ENG/7", ".hidden"])("refuses the identifier %j", (identifier) => {
    expect(() => sessionObjectPrefix(identifier)).toThrow(`not a ticket identifier: ${JSON.stringify(identifier)}`);
  });
});

describe("steward sessions pull and push", () => {
  it("pulls an absent prefix into an empty folder and succeeds", async () => {
    const configDir = join(dir, "sessions");
    const { test, run } = cli(configDir, new MemoryObjectStore(), "pull");

    await run;

    const folder = sessionFolder(configDir, WORKTREE);
    expect(await readdir(folder)).toEqual([]);
    expect(test.stdout()).toBe(`pulled 0 files into ${folder}\n`);
  });

  it("round-trips a ticket's transcripts and nothing outside its folder", async () => {
    const store = new MemoryObjectStore();
    const from = join(dir, "a");
    const folder = sessionFolder(from, WORKTREE);
    await writeIn(join(folder, "s1.jsonl"), '{"type":"user"}\n');
    await writeIn(join(folder, "s1", "subagents", "agent-1.jsonl"), '{"type":"assistant"}\n');
    await writeIn(join(from, "projects", "-var-lib-ticket-steward-work-ticket-ENG-8", "other.jsonl"), "other ticket\n");
    await writeIn(join(from, ".credentials.json"), "{}");

    const push = cli(from, store, "push");
    await push.run;

    expect([...store.objects.keys()].sort()).toEqual(["sessions/ENG-7/s1.jsonl", "sessions/ENG-7/s1/subagents/agent-1.jsonl"]);
    expect(push.test.stdout()).toBe("pushed 2 files to s3://steward-sessions/sessions/ENG-7/, 0 unchanged\n");

    const to = join(dir, "b");
    await cli(to, store, "pull").run;

    const pulled = sessionFolder(to, WORKTREE);
    expect(await listTree(pulled)).toEqual(["s1.jsonl", join("s1", "subagents", "agent-1.jsonl")]);
    expect(await readFile(join(pulled, "s1.jsonl"), "utf8")).toBe('{"type":"user"}\n');
    expect(await readFile(join(pulled, "s1", "subagents", "agent-1.jsonl"), "utf8")).toBe('{"type":"assistant"}\n');
  });

  it("sends only the files that changed since the last push", async () => {
    const store = new MemoryObjectStore();
    const folder = sessionFolder(dir, WORKTREE);
    await writeIn(join(folder, "s1.jsonl"), "one\n");
    await writeIn(join(folder, "s2.jsonl"), "two\n");
    const pusher = new SessionPusher({ store, identifier: "ENG-7", folder });

    expect(await pusher.push()).toEqual({ pushed: 2, unchanged: 0 });
    expect(await pusher.push()).toEqual({ pushed: 0, unchanged: 2 });
    await appendFile(join(folder, "s2.jsonl"), "three\n");
    expect(await pusher.push()).toEqual({ pushed: 1, unchanged: 1 });

    expect(store.puts).toEqual(["sessions/ENG-7/s1.jsonl", "sessions/ENG-7/s2.jsonl", "sessions/ENG-7/s2.jsonl"]);
    expect(store.text("sessions/ENG-7/s2.jsonl")).toBe("two\nthree\n");
  });

  it("does not send pulled files back until they change, even from a new process", async () => {
    const store = new MemoryObjectStore();
    await store.put("sessions/ENG-7/s1.jsonl", new TextEncoder().encode("one\n"));
    await store.put("sessions/ENG-7/s2.jsonl", new TextEncoder().encode("two\n"));
    const folder = sessionFolder(dir, WORKTREE);
    await pullSession({ store, identifier: "ENG-7", folder });
    store.puts.length = 0;
    await appendFile(join(folder, "s1.jsonl"), "more\n");

    const { test, run } = cli(dir, store, "push");
    await run;

    expect(store.puts).toEqual(["sessions/ENG-7/s1.jsonl"]);
    expect(test.stdout()).toContain("pushed 1 file to s3://steward-sessions/sessions/ENG-7/, 1 unchanged");
  });

  it("never follows a link out of the session folder", async () => {
    const store = new MemoryObjectStore();
    const folder = sessionFolder(join(dir, "sessions"), WORKTREE);
    await writeIn(join(dir, "secrets", "minio", "token"), "the sync container's token\n");
    await writeIn(join(folder, "s1.jsonl"), "one\n");
    await symlink(join(dir, "secrets", "minio", "token"), join(folder, "token.jsonl"));
    await symlink(join(dir, "secrets"), join(folder, "linked"));

    expect(await new SessionPusher({ store, identifier: "ENG-7", folder }).push()).toEqual({ pushed: 1, unchanged: 0 });

    expect([...store.objects.keys()]).toEqual(["sessions/ENG-7/s1.jsonl"]);
  });

  it("refuses an object whose key leaves the ticket's folder and writes nothing", async () => {
    const store = new MemoryObjectStore();
    await store.put("sessions/ENG-7/ok.jsonl", new TextEncoder().encode("ok\n"));
    await store.put("sessions/ENG-7/../../escaped.jsonl", new TextEncoder().encode("x\n"));
    const configDir = join(dir, "sessions");
    const { test, run } = cli(configDir, store, "pull");

    await expect(run).rejects.toBeInstanceOf(ExitSignal);

    expect(test.stderr()).toContain('sessions pull: refusing object "sessions/ENG-7/../../escaped.jsonl": its name leaves the session folder');
    expect(await listTree(dir)).toEqual([]);
  });

  it("fails naming the identifier when it is not a ticket key", async () => {
    const { test, run } = cli(join(dir, "sessions"), new MemoryObjectStore(), "push", "../ENG-7");

    await expect(run).rejects.toBeInstanceOf(ExitSignal);

    expect(test.stderr()).toContain('sessions push: not a ticket identifier: "../ENG-7"');
  });
});

describe("syncSession", () => {
  it("keeps pushing after a failed push and pushes once more when stopped", async () => {
    const store = new MemoryObjectStore();
    const folder = sessionFolder(dir, WORKTREE);
    await writeIn(join(folder, "s1.jsonl"), "one\n");
    let failNext = true;
    const flaky: ObjectStore = {
      list: (prefix) => store.list(prefix),
      get: (key) => store.get(key),
      put: async (key, body) => {
        if (failNext) {
          failNext = false;
          throw new Error("connection reset");
        }
        await store.put(key, body);
      },
    };
    const errors: string[] = [];
    const controller = new AbortController();
    // Once the retried push lands, the transcript grows and the pod is told to stop before the next tick.
    const onPush = (result: PushResult): void => {
      if (result.pushed === 0) return;
      appendFileSync(join(folder, "s1.jsonl"), "two\n");
      controller.abort();
    };

    const done = syncSession({ pusher: new SessionPusher({ store: flaky, identifier: "ENG-7", folder }), intervalMs: 5, signal: controller.signal, onPush, onError: (err) => errors.push(err.message) });

    expect(await done).toEqual({ pushed: 1, unchanged: 0 });
    expect(store.text("sessions/ENG-7/s1.jsonl")).toBe("one\ntwo\n");
    expect(errors).toEqual(["connection reset"]);
  });
});

describe("sessions against MinIO", () => {
  const tokenFile = (): string => join(dir, "minio-token");

  beforeEach(async () => {
    minio = await startFakeMinio({ bucket: "steward-sessions", token: TOKEN });
    await writeFile(tokenFile(), `${TOKEN}\n`);
  });

  it("signs in through STS with the pod's projected token", async () => {
    const credentials = await minioCredentials({ endpoint: fake().endpoint, tokenFile: tokenFile(), durationSeconds: 3600 });

    expect(credentials.accessKeyId).toBe(FAKE_ACCESS_KEY);
    expect(credentials.expiration?.getTime()).toBeGreaterThan(Date.now() + 3500_000);
    expect(fake().stsCalls).toEqual([expect.objectContaining({ Action: "AssumeRoleWithWebIdentity", WebIdentityToken: TOKEN, DurationSeconds: "3600" })]);
    expect(fake().stsCalls[0]).not.toHaveProperty("RoleArn");
  });

  it("names the token file, never the token, when sign-in fails", async () => {
    await writeFile(tokenFile(), "a-token-minio-rejects");

    const rejection = minioCredentials({ endpoint: fake().endpoint, tokenFile: tokenFile(), durationSeconds: 3600 });

    await expect(rejection).rejects.toThrow(`MinIO STS: AssumeRoleWithWebIdentity at ${fake().endpoint} with the token in ${tokenFile()} failed`);
    await expect(rejection).rejects.not.toThrow("a-token-minio-rejects");
    await expect(minioCredentials({ endpoint: fake().endpoint, tokenFile: join(dir, "absent"), durationSeconds: 3600 })).rejects.toThrow(`MinIO STS: cannot read the token file ${join(dir, "absent")}`);
  });

  it("lists, gets and puts objects with the STS credentials", async () => {
    const store = s3ObjectStore({ endpoint: fake().endpoint, bucket: "steward-sessions", credentials: () => minioCredentials({ endpoint: fake().endpoint, tokenFile: tokenFile(), durationSeconds: 3600 }) });

    await store.put("sessions/ENG-7/s 1.jsonl", new TextEncoder().encode("one\n"));

    expect(await store.list("sessions/ENG-7/")).toEqual([{ key: "sessions/ENG-7/s 1.jsonl", size: 4, lastModified: expect.any(Date) }]);
    expect(await store.list("sessions/ENG-8/")).toEqual([]);
    expect(Buffer.from(await store.get("sessions/ENG-7/s 1.jsonl")).toString("utf8")).toBe("one\n");
    expect(fake().rejected).toEqual([]);
    expect(fake().stsCalls).toHaveLength(1);
  });

  it("signs in again once when MinIO turns its credentials away after a restart", async () => {
    const store = s3ObjectStore({ endpoint: fake().endpoint, bucket: "steward-sessions", credentials: () => minioCredentials({ endpoint: fake().endpoint, tokenFile: tokenFile(), durationSeconds: 3600 }) });
    await store.put("sessions/ENG-7/s1.jsonl", new TextEncoder().encode("one\n"));

    fake().restart();
    await store.put("sessions/ENG-7/s1.jsonl", new TextEncoder().encode("one\ntwo\n"));

    expect(fake().store.text("sessions/ENG-7/s1.jsonl")).toBe("one\ntwo\n");
    expect(fake().rejected).toEqual(["PUT /steward-sessions/sessions/ENG-7/s1.jsonl"]);
    expect(fake().stsCalls).toHaveLength(2);
    // Other failures are not a reason to sign in again.
    await expect(store.get("sessions/ENG-7/absent")).rejects.toThrow("MinIO: reading s3://steward-sessions/sessions/ENG-7/absent failed");
    expect(fake().stsCalls).toHaveLength(2);
  });

  it("fails after one fresh sign-in when MinIO keeps turning the credentials away", async () => {
    const store = s3ObjectStore({ endpoint: fake().endpoint, bucket: "steward-sessions", credentials: async () => ({ accessKeyId: "WRONG", secretAccessKey: "wrong", sessionToken: "wrong" }) });

    await expect(store.list("sessions/ENG-7/")).rejects.toThrow("MinIO: listing s3://steward-sessions/sessions/ENG-7/ failed: AccessDenied");

    expect(fake().rejected).toEqual(["GET /steward-sessions/", "GET /steward-sessions/"]);
  });

  it("pushes a change made before SIGTERM, then exits 0", async () => {
    const configDir = join(dir, "sessions");
    const folder = sessionFolder(configDir, WORKTREE);
    await writeIn(join(folder, "s1.jsonl"), "one\n");
    const child = spawn(
      process.execPath,
      ["--import", tsxLoader, resolve("src/cli/main.ts"), "sessions", "sync", "--identifier", "ENG-7", "--worktree", WORKTREE, "--config-dir", configDir, "--bucket", "steward-sessions", "--endpoint", fake().endpoint, "--token-file", tokenFile(), "--interval", "60"],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
    const exited = new Promise<number | null>((resolveExit) => child.on("exit", (code) => resolveExit(code)));

    await vi.waitFor(() => expect(stdout).toContain("syncing"), { timeout: 15_000, interval: 50 });
    await appendFile(join(folder, "s1.jsonl"), "two\n");
    child.kill("SIGTERM");

    expect(await exited).toBe(0);
    expect(stderr).toBe("");
    expect(fake().store.text("sessions/ENG-7/s1.jsonl")).toBe("one\ntwo\n");
    expect(stdout).toContain(`syncing ${folder} to s3://steward-sessions/sessions/ENG-7/ every 60s`);
    expect(stdout).toContain("final push: pushed 1 file to s3://steward-sessions/sessions/ENG-7/, 0 unchanged");
  }, 30_000);
});

describe("pullSession", () => {
  it("leaves each pulled file's mtime at its object's LastModified", async () => {
    const store = new MemoryObjectStore();
    await store.put("sessions/ENG-7/s1.jsonl", new TextEncoder().encode("one\n"));
    const folder = sessionFolder(dir, WORKTREE);

    expect(await pullSession({ store, identifier: "ENG-7", folder })).toBe(1);

    const [object] = await store.list("sessions/ENG-7/");
    expect(Math.round((await stat(join(folder, "s1.jsonl"))).mtimeMs)).toBe(object?.lastModified.getTime());
  });
});
