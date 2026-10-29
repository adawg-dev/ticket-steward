import { randomBytes } from "node:crypto";
import { access, chmod, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import type { V1Container, V1Job } from "@kubernetes/client-node";
import { execa } from "execa";
import { buildRunJob } from "../../src/k8s/runJob.js";
import { podSpecFor, RUNTIME, TOKENS } from "../k8s/helpers.js";

/**
 * The run pod's images together, as the pod runs them: render-overlay in the steward image writes the egress rules, and
 * the egress sidecar, as the user the Job gives it, reads them and opens its port. Docker only, so it runs when both
 * images are named: STEWARD_SMOKE_STEWARD_IMAGE and STEWARD_SMOKE_EGRESS_IMAGE (tags under steward-k3s-test/).
 */
const stewardImage = process.env.STEWARD_SMOKE_STEWARD_IMAGE;
const egressImage = process.env.STEWARD_SMOKE_EGRESS_IMAGE;

const job: V1Job = buildRunJob(podSpecFor(), { runtime: RUNTIME, tokens: TOKENS, specConfigMap: "run-7-1", checksTimeoutMinutes: 20 });
const named = (name: string): V1Container => {
  const container = job.spec?.template.spec?.initContainers?.find((candidate) => candidate.name === name);
  if (container === undefined) throw new Error(`no container ${name}`);
  return container;
};
/** `docker run --user` for a container of the Job; the image's own user when the Job sets none. */
const userOf = (container: V1Container): string[] => {
  const context = container.securityContext;
  if (context?.runAsUser === undefined) return [];
  return ["--user", `${context.runAsUser}:${context.runAsGroup ?? context.runAsUser}`];
};
const envOf = (container: V1Container): string[] => (container.env ?? []).flatMap((variable) => ["-e", `${variable.name}=${variable.value ?? ""}`]);

/** writeRenderedOverlay from the image's own build, with one rule whose value is no secret. */
const RENDER = `
const { writeRenderedOverlay } = await import("/opt/ticket-steward/dist/overlay/template.js");
await writeRenderedOverlay(
  { files: [], rules: [{ placeholder: "STEWARD_PH_SMOKE_0123456789abcdef", value: "smoke-value", hosts: ["api.example.com"] }], guardValues: [] },
  { agentOut: "/run/steward/overlay", rulesOut: "/run/egress-rules/rules.json", guardOut: "/run/steward/guard/guard.json" },
);
`;

describe.skipIf(stewardImage === undefined || egressImage === undefined)("the run pod's images", () => {
  let dir: string;
  const name = `steward-k3s-test-smoke-${randomBytes(4).toString("hex")}`;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "steward-smoke-"));
    // emptyDirs: root-owned, mode 0777.
    for (const volume of ["rules", "guard", "overlay", "egress-ca", "egress-confdir"]) {
      await mkdir(join(dir, volume));
      await chmod(join(dir, volume), 0o777);
    }
  });

  afterEach(async () => {
    await execa("docker", ["rm", "-f", name], { reject: false });
    await rm(dir, { recursive: true, force: true });
  });

  it("has egress read the rules render-overlay writes and open its port", { timeout: 120_000 }, async () => {
    await execa("docker", [
      "run", "--rm", ...userOf(named("render-overlay")),
      "-v", `${join(dir, "rules")}:/run/egress-rules`, "-v", `${join(dir, "guard")}:/run/steward/guard`, "-v", `${join(dir, "overlay")}:/run/steward/overlay`,
      "--entrypoint", "node", stewardImage ?? "", "--input-type=module", "-e", RENDER,
    ]);

    const egress = named("egress");
    await execa("docker", [
      "run", "-d", "--name", name, ...userOf(egress), ...envOf(egress),
      "-v", `${join(dir, "rules")}:/run/egress-rules:ro`, "-v", `${join(dir, "egress-ca")}:/run/egress-ca`, "-v", `${join(dir, "egress-confdir")}:/run/egress-confdir`,
      egressImage ?? "",
    ]);

    const listening = async (): Promise<boolean> =>
      (await execa("docker", ["exec", name, "python3", "-I", "-c", "import socket; socket.create_connection(('127.0.0.1', 4182), 1).close()"], { reject: false })).exitCode === 0;
    let up = false;
    for (let attempt = 0; attempt < 60 && !up; attempt += 1) {
      up = await listening();
      if (!up) await sleep(500);
    }
    const logs = await execa("docker", ["logs", name], { reject: false, all: true });
    expect(up, logs.all).toBe(true);
    await expect(access(join(dir, "egress-ca", "ca.pem"))).resolves.toBeUndefined();
  });
});
