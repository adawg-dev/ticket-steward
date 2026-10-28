import { listenHost } from "../../src/cli/serve.js";

describe("listenHost", () => {
  it("binds localhost unless the environment names an address", () => {
    expect(listenHost({})).toBe("localhost");
    expect(listenHost({ STEWARD_LISTEN_HOST: "0.0.0.0" })).toBe("0.0.0.0");
  });
});
