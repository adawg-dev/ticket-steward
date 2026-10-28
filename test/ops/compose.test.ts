import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { execa } from "execa";
import { z } from "zod";

const hasCompose = spawnSync("docker", ["compose", "version"], { stdio: "ignore" }).status === 0;

const Volume = z.object({ type: z.string(), source: z.string().optional(), target: z.string(), read_only: z.boolean().optional() });
const Service = z.object({
  image: z.string().optional(),
  privileged: z.boolean().optional(),
  command: z.array(z.string()).nullish(),
  network_mode: z.string().optional(),
  restart: z.string().optional(),
  user: z.string().optional(),
  ports: z.array(z.object({ host_ip: z.string().optional(), target: z.number(), published: z.string().optional() })).optional(),
  volumes: z.array(Volume).default([]),
});
const ComposeConfig = z.object({ services: z.record(z.string(), Service) });
type ComposeService = z.infer<typeof Service>;

/** The stack as Compose resolves it with every interpolation variable left at its default. */
const resolvedServices = async (): Promise<Record<string, ComposeService>> => {
  const env = { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "" };
  const { stdout } = await execa("docker", ["compose", "-f", "compose.yaml", "-p", "steward-test", "config", "--format", "json"], { env, extendEnv: false });
  return ComposeConfig.parse(JSON.parse(stdout)).services;
};

const service = (services: Record<string, ComposeService>, name: string): ComposeService => {
  const found = services[name];
  if (found === undefined) throw new Error(`compose.yaml has no ${name} service`);
  return found;
};

const mountedAt = (svc: ComposeService, target: string) => svc.volumes.find((volume) => volume.target === target);

describe.skipIf(!hasCompose)("compose.yaml", () => {
  let services: Record<string, ComposeService>;

  beforeAll(async () => {
    services = await resolvedServices();
  });

  it("runs exactly dind, slot-helper and steward, all restarted unless stopped", () => {
    expect(Object.keys(services).sort()).toEqual(["dind", "slot-helper", "steward"]);
    for (const svc of Object.values(services)) expect(svc.restart).toBe("unless-stopped");
  });

  it("runs dockerd from a pinned dind image on a unix socket only", () => {
    const dind = service(services, "dind");
    expect(dind.image).toMatch(/^docker:\d+\.\d+\.\d+-dind$/);
    expect(dind.privileged).toBe(true);
    expect(dind.command).toEqual(["dockerd", "--host=unix:///var/run/dind/docker.sock"]);
  });

  it("publishes only the steward's port, on loopback", () => {
    expect(service(services, "dind").ports).toEqual([{ host_ip: "127.0.0.1", target: 3020, published: "3020" }]);
    expect(service(services, "slot-helper").ports).toBeUndefined();
    expect(service(services, "steward").ports).toBeUndefined();
  });

  it("puts slot-helper and steward in dind's network namespace", () => {
    expect(service(services, "slot-helper").network_mode).toBe("service:dind");
    expect(service(services, "steward").network_mode).toBe("service:dind");
  });

  it("gives the docker socket to slot-helper and never to the steward", () => {
    expect(mountedAt(service(services, "slot-helper"), "/var/run/dind")?.source).toBe("dind-sock");
    expect(service(services, "steward").volumes.some((volume) => volume.source === "dind-sock")).toBe(false);
    expect(mountedAt(service(services, "slot-helper"), "/run/slot")?.source).toBe("slot-sock");
    expect(mountedAt(service(services, "steward"), "/run/slot")?.source).toBe("slot-sock");
  });

  it("mounts the config read-only and the data dir read-write, as uid 1001 by default", () => {
    const steward = service(services, "steward");
    expect(mountedAt(steward, "/etc/ticket-steward")).toMatchObject({ type: "bind", source: "/etc/ticket-steward", read_only: true });
    expect(mountedAt(steward, "/var/lib/ticket-steward")?.read_only).not.toBe(true);
    expect(steward.user).toBe("1001:1001");
  });

  it("gives dind's daemon the init scripts the slot compose file bind-mounts", () => {
    expect(mountedAt(service(services, "dind"), "/etc/ticket-steward/slots/init")).toMatchObject({ source: resolve("ops/slots-init"), read_only: true });
  });
});

describe("images", () => {
  it.each(["Dockerfile", "ops/slot-helper/Dockerfile"])("%s pins every base image to an exact version", async (path) => {
    const text = await readFile(path, "utf8");
    const images = [...text.matchAll(/^(?:FROM|ARG NODE_IMAGE=)\s*(\S+)/gm)].map((match) => match[1] ?? "").filter((image) => !image.startsWith("$"));
    expect(images.length).toBeGreaterThan(0);
    for (const image of images) expect(image).toMatch(/^[a-z]+:\d+\.\d+\.\d+(-[a-z0-9-]+)?$/);
    expect(text).not.toMatch(/:latest\b/);
  });

  it("installs native glab 1.125.0 and Orbit 0.161.0, each checked against a pinned sha256", async () => {
    const text = await readFile("Dockerfile", "utf8");
    expect(text).toMatch(/^ARG GLAB_VERSION=1\.125\.0$/m);
    expect(text).toMatch(/^ARG ORBIT_VERSION=0\.161\.0$/m);
    for (const name of ["GLAB_SHA256_AMD64", "GLAB_SHA256_ARM64", "ORBIT_SHA256_AMD64", "ORBIT_SHA256_ARM64"]) expect(text).toMatch(new RegExp(`^ARG ${name}=[0-9a-f]{64}$`, "m"));
    expect(text.match(/sha256sum -c -/g)).toHaveLength(2);
  });

  it("serves the unchanged helper protocol on the shared socket, one helper per connection", async () => {
    const serve = await readFile("ops/slot-helper/serve.sh", "utf8");
    expect(serve).toContain("UNIX-LISTEN:/run/slot/steward-slot.sock,fork,");
    expect(serve).toContain("mode=0660");
    expect(serve).toContain("/usr/local/sbin/steward-slot --socket");
  });
});
