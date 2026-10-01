import { listProtectedBranches, protectionProblems, type ProtectedBranch } from "../../src/codehost/gitlabProtection.js";

const level = (accessLevel: number, description: string, userId: number | null = null) => ({ accessLevel, description, userId, groupId: null, deployKeyId: null });

describe("protectionProblems", () => {
  const good: ProtectedBranch[] = [
    { name: "main", push: [level(40, "Ada Lovelace", 1)], merge: [level(0, "No one")] },
    { name: "dev", push: [level(30, "Grace Hopper", 2)], merge: [level(40, "Maintainers")] },
  ];

  it("passes named-user and maintainer-only protection", () => {
    expect(protectionProblems(good, ["main", "dev"])).toEqual([]);
  });

  it("flags a missing branch", () => {
    expect(protectionProblems(good, ["main", "dev", "staging"])).toEqual(["staging is not protected"]);
  });

  it("flags a role grant that lets Developers push or merge", () => {
    const loose = [{ name: "dev", push: [level(30, "Developers + Maintainers")], merge: [] }];
    expect(protectionProblems(loose, ["dev"])).toEqual(["dev lets Developers push"]);
  });

  it("flags a project bot on an allowlist", () => {
    const bot = [{ name: "main", push: [], merge: [level(30, "project_74525306_bot_ab12", 9)] }];
    expect(protectionProblems(bot, ["main"])).toEqual(["main lets project_74525306_bot_ab12 merge"]);
  });
});

describe("listProtectedBranches", () => {
  it("reads and maps the API response", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () =>
      new Response(JSON.stringify([{ name: "main", push_access_levels: [{ access_level: 40, access_level_description: "Maintainers", user_id: null, group_id: null, deploy_key_id: null }], merge_access_levels: [] }]), { status: 200 }),
    );
    const branches = await listProtectedBranches({ baseUrl: "https://gitlab.example", project: "acme/repo", token: "t", fetchImpl });
    expect(branches).toEqual([{ name: "main", push: [level(40, "Maintainers")], merge: [] }]);
    expect(fetchImpl.mock.calls[0]?.[0]).toBe("https://gitlab.example/api/v4/projects/acme%2Frepo/protected_branches?per_page=100");
  });
});
