import { join } from "node:path";
import { buildProgram } from "../../src/cli/program.js";
import { ExitSignal, makeContext, tmpConfigDir, writeConfig } from "./helpers.js";

describe("steward keyproxy", () => {
  it("refuses to listen off the loopback before loading anything", async () => {
    const test = makeContext();
    const program = buildProgram(test.ctx);

    await expect(program.parseAsync(["node", "steward", "--config", "/nonexistent/steward.config.ts", "keyproxy", "--listen", "0.0.0.0:4180"])).rejects.toBeInstanceOf(ExitSignal);

    expect(test.stderr()).toContain("keyproxy: keyproxy listens on 127.0.0.1 only");
  });

  it("refuses to start without a model credential", async () => {
    const dir = await tmpConfigDir();
    const configPath = await writeConfig(dir, { dataDir: join(dir, "data"), overlayDir: join(dir, "overlay"), fetchUrl: "https://gitlab.example/acme/repo.git", port: 4100, serverPort: 3020 });
    const test = makeContext();
    const program = buildProgram(test.ctx);

    await expect(program.parseAsync(["node", "steward", "--config", configPath, "keyproxy", "--listen", "127.0.0.1:4180"])).rejects.toBeInstanceOf(ExitSignal);

    expect(test.stderr()).toContain("keyproxy needs one of ANTHROPIC_API_KEY, ANTHROPIC_AUTH_TOKEN or CLAUDE_CODE_OAUTH_TOKEN");
  });
});
