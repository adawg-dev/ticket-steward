import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { buildProgram } from "../../src/cli/program.js";
import { ExitSignal, makeContext, tmpConfigDir, writeConfig } from "./helpers.js";

let dir: string;
let configPath: string;
let templateDir: string;

beforeEach(async () => {
  dir = await tmpConfigDir();
  templateDir = join(dir, "template");
  await mkdir(join(templateDir, "apps", "api"), { recursive: true });
  await writeFile(join(templateDir, "apps", "api", ".env"), "STRIPE_SECRET_KEY={{secret:DEV_S@api.stripe.com}}\nJWT_SECRET={{local}}\n");
  configPath = await writeConfig(dir, { dataDir: join(dir, "data"), overlayDir: join(dir, "overlay"), fetchUrl: "https://gitlab.example/acme/repo.git", port: 4100, serverPort: 3020 });
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const args = (out: string): string[] => [
  "node", "steward", "--config", configPath, "render-overlay",
  "--template", templateDir, "--agent-out", join(out, "agent"), "--rules-out", join(out, "egress", "rules.json"), "--guard-out", join(out, "guard", "guard.json"),
];

describe("steward render-overlay", () => {
  it("writes placeholders for the agent and the real values only into the rules and guard files", async () => {
    const out = join(dir, "out");
    const test = makeContext({ factories: { secretFetcher: { get: async (id) => (id === "DEV_S" ? "sk_test_1" : null) } } });

    await buildProgram(test.ctx).parseAsync(args(out));

    const agentFile = await readFile(join(out, "agent", "apps", "api", ".env"), "utf8");
    expect(agentFile).toMatch(/^STRIPE_SECRET_KEY=STEWARD_PH_STRIPE_SECRET_KEY_[0-9a-f]{16}\nJWT_SECRET=[0-9a-f]{64}\n$/);
    expect(await readFile(join(out, "egress", "rules.json"), "utf8")).toContain("sk_test_1");
    expect((await stat(join(out, "guard", "guard.json"))).mode & 0o777).toBe(0o600);
    expect(test.stdout()).toBe("rendered 1 file with 1 egress rule\n");
    expect(test.stdout()).not.toContain("sk_test_1");
  });

  it("refuses to render from the config dir's .env", async () => {
    const test = makeContext();

    await expect(buildProgram(test.ctx).parseAsync(args(join(dir, "out")))).rejects.toBeInstanceOf(ExitSignal);

    expect(test.stderr()).toContain('render-overlay: overlay secrets come from Secrets Manager; set secrets.source to "aws"');
  });

  it("fails naming the signed entry and writes nothing", async () => {
    await writeFile(join(templateDir, ".env"), "AWS_SECRET_ACCESS_KEY={{signed:DEV_X}}\n");
    const test = makeContext({ factories: { secretFetcher: { get: async () => "real" } } });

    await expect(buildProgram(test.ctx).parseAsync(args(join(dir, "out")))).rejects.toBeInstanceOf(ExitSignal);

    expect(test.stderr()).toContain("render-overlay: .env:1: DEV_X is used to sign requests; the egress proxy cannot stand in for it");
    await expect(stat(join(dir, "out"))).rejects.toThrow();
  });
});
