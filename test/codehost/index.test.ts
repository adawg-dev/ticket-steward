import { createCodeHost } from "../../src/codehost/index.js";

beforeEach(() => {
  vi.restoreAllMocks();
});

describe("createCodeHost", () => {
  it("builds a gitlab host from config", () => {
    const host = createCodeHost(
      { kind: "gitlab", baseUrl: "https://gitlab.com", project: "concentrateai/kickoff" },
      { GITLAB_TOKEN: "glpat-secret" },
    );

    expect(host.kind).toBe("gitlab");
    expect(host.permalink("src/a.ts", "abc", 1)).toBe(
      "https://gitlab.com/concentrateai/kickoff/-/blob/abc/src/a.ts#L1",
    );
  });

  it("builds a github host from config", () => {
    const host = createCodeHost({ kind: "github", owner: "concentrateai", repo: "kickoff" }, { GITHUB_TOKEN: "ghp_x" });

    expect(host.kind).toBe("github");
    expect(host.permalink("src/a.ts", "abc")).toBe("https://github.com/concentrateai/kickoff/blob/abc/src/a.ts");
  });
});
