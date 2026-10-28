import { buildProgram } from "../../src/cli/program.js";
import { ExitSignal, makeContext } from "./helpers.js";

describe("steward mcp push", () => {
  it("refuses a target that does not match the schema before loading anything", async () => {
    const test = makeContext();
    const program = buildProgram(test.ctx);

    await expect(program.parseAsync(["node", "steward", "--config", "/nonexistent/steward.config.ts", "mcp", "push", "--target", '{"jobId":1}'])).rejects.toBeInstanceOf(ExitSignal);

    expect(test.stderr()).toContain("mcp push: invalid --target");
  });

  it("requires --config", async () => {
    const test = makeContext();
    const program = buildProgram(test.ctx);

    await expect(program.parseAsync(["node", "steward", "mcp", "push", "--target", "{}"])).rejects.toBeInstanceOf(ExitSignal);

    expect(test.stderr()).toContain("mcp push requires --config");
  });
});
