import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { SecretFetcher } from "../../src/config/secretSource.js";
import { overlayTemplateIssues, overlayTemplateSummary, renderOverlay, writeRenderedOverlay } from "../../src/overlay/template.js";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "steward-overlay-template-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** Writes each file under the template dir. */
const template = async (files: Record<string, string>): Promise<string> => {
  const root = join(dir, "template");
  for (const [path, content] of Object.entries(files)) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), content);
  }
  return root;
};

/** Serves `values` by id and counts the reads; anything else is not found. */
const fetcher = (values: Record<string, string>): SecretFetcher & { reads: string[] } => {
  const reads: string[] = [];
  return {
    reads,
    get: async (id) => {
      reads.push(id);
      return values[id] ?? null;
    },
  };
};

describe("renderOverlay", () => {
  it("replaces an outbound secret with a placeholder and a rule for its hosts", async () => {
    const templateDir = await template({ "apps/api/.env": "STRIPE_SECRET_KEY={{secret:DEV_S@api.stripe.com}}\n" });

    const rendered = await renderOverlay({ templateDir, fetcher: fetcher({ DEV_S: '{"STRIPE_SECRET_KEY":"sk_test_1"}' }) });

    expect(rendered.files).toHaveLength(1);
    expect(rendered.files[0]?.path).toBe("apps/api/.env");
    const placeholder = /^STRIPE_SECRET_KEY=(.*)$/m.exec(rendered.files[0]?.content ?? "")?.[1];
    expect(placeholder).toMatch(/^STEWARD_PH_STRIPE_SECRET_KEY_[0-9a-f]{16}$/);
    expect(rendered.rules).toEqual([{ placeholder, value: "sk_test_1", hosts: ["api.stripe.com"], swapIn: ["headers"] }]);
    expect(rendered.guardValues).toEqual(expect.arrayContaining(["sk_test_1", placeholder]));
  });

  it("splits a host list and keeps the rest of the line", async () => {
    const templateDir = await template({ ".env": 'export TWILIO_AUTH_TOKEN="{{secret:DEV_T@api.twilio.com,*.twilio.com}}" # sandbox\n' });

    const rendered = await renderOverlay({ templateDir, fetcher: fetcher({ DEV_T: "tw-real\n" }) });

    expect(rendered.files[0]?.content).toMatch(/^export TWILIO_AUTH_TOKEN="STEWARD_PH_TWILIO_AUTH_TOKEN_[0-9a-f]{16}" # sandbox\n$/);
    expect(rendered.rules[0]).toMatchObject({ value: "tw-real", hosts: ["api.twilio.com", "*.twilio.com"] });
  });

  it("gives one key the same placeholder in every file and reads each secret once", async () => {
    const line = "STRIPE_SECRET_KEY={{secret:DEV_S@api.stripe.com}}\n";
    const templateDir = await template({ "apps/api/.env": line, "apps/web/.env": line });
    const source = fetcher({ DEV_S: "sk_test_1" });

    const rendered = await renderOverlay({ templateDir, fetcher: source });

    expect(rendered.files[0]?.content).toBe(rendered.files[1]?.content);
    expect(rendered.rules).toHaveLength(1);
    expect(source.reads).toEqual(["DEV_S"]);
  });

  it("renders {{local}} as fresh 32-byte hex on every render, the same for one key across files", async () => {
    const templateDir = await template({ "apps/api/.env": "JWT_SECRET={{local}}\n", "apps/web/.env": "JWT_SECRET={{local}}\n" });

    const first = await renderOverlay({ templateDir, fetcher: fetcher({}) });
    const second = await renderOverlay({ templateDir, fetcher: fetcher({}) });

    const value = /^JWT_SECRET=(.*)$/m.exec(first.files[0]?.content ?? "")?.[1];
    expect(value).toMatch(/^[0-9a-f]{64}$/);
    expect(first.files[1]?.content).toBe(first.files[0]?.content);
    expect(second.files[0]?.content).not.toBe(first.files[0]?.content);
    expect(first.rules).toEqual([]);
  });

  it("uses the injected random source for {{local}}", async () => {
    const templateDir = await template({ ".env": "A={{local}}\nB={{local}}\n" });
    let n = 0;

    const rendered = await renderOverlay({ templateDir, fetcher: fetcher({}), random: () => `r${++n}` });

    expect(rendered.files[0]?.content).toBe("A=r1\nB=r2\n");
  });

  it("refuses a key the request is signed with", async () => {
    const templateDir = await template({ ".env": "AWS_SECRET_ACCESS_KEY={{signed:DEV_X}}\n" });

    await expect(renderOverlay({ templateDir, fetcher: fetcher({ DEV_X: "real" }) })).rejects.toThrow(
      "DEV_X is used to sign requests; the egress proxy cannot stand in for it",
    );
  });

  it("refuses a secret without hosts", async () => {
    const templateDir = await template({ ".env": "X={{secret:DEV_X}}\n" });

    await expect(renderOverlay({ templateDir, fetcher: fetcher({ DEV_X: "real" }) })).rejects.toThrow(".env:1: {{secret:DEV_X}} names no hosts");
  });

  it("keeps anything else as a literal", async () => {
    const content = "DATABASE_URL=postgres://steward:pw@localhost:5432/dev\nNEXT_PUBLIC_X={{unknown}}\n# comment {{local}} \n";
    const templateDir = await template({ ".env": content });

    const rendered = await renderOverlay({ templateDir, fetcher: fetcher({}) });

    expect(rendered.files[0]?.content).toMatch(/^DATABASE_URL=postgres:\/\/steward:pw@localhost:5432\/dev\nNEXT_PUBLIC_X=\{\{unknown\}\}\n# comment [0-9a-f]{64} \n$/);
  });

  it("fails naming the id of a missing or empty secret, never a value", async () => {
    const missing = await template({ ".env": "X={{secret:DEV_MISSING@x.example}}\n" });
    await expect(renderOverlay({ templateDir: missing, fetcher: fetcher({}) })).rejects.toThrow("Secrets Manager: DEV_MISSING not found");

    await rm(join(dir, "template"), { recursive: true });
    const empty = await template({ ".env": "X={{secret:DEV_EMPTY@x.example}}\n" });
    await expect(renderOverlay({ templateDir: empty, fetcher: fetcher({ DEV_EMPTY: "\n" }) })).rejects.toThrow("Secrets Manager: DEV_EMPTY is empty");
  });

  it("never writes a fetched value into an agent file, refusing a literal that carries one", async () => {
    const templateDir = await template({ ".env": "STRIPE_SECRET_KEY={{secret:DEV_S@api.stripe.com}}\nOTHER=sk_test_leaked\n" });

    const error = await renderOverlay({ templateDir, fetcher: fetcher({ DEV_S: "sk_test_leaked" }) }).catch((err: unknown) => err);

    expect(error).toBeInstanceOf(Error);
    expect(String(error)).toContain(".env carries the value of DEV_S");
    expect(String(error)).not.toContain("sk_test_leaked");
  });

  it("renders agent files that hold none of the fetched values", async () => {
    const templateDir = await template({
      "apps/api/.env": "STRIPE_SECRET_KEY={{secret:DEV_S@api.stripe.com}}\nSENDGRID_API_KEY={{secret:DEV_G@api.sendgrid.com}}\n",
      "apps/web/.env.local": "HUBSPOT_TOKEN={{secret:DEV_H@api.hubapi.com}}\n",
    });
    const values = { DEV_S: "sk_test_1", DEV_G: "SG.real", DEV_H: '{"HUBSPOT_TOKEN":"pat-real"}' };

    const rendered = await renderOverlay({ templateDir, fetcher: fetcher(values) });

    for (const file of rendered.files) {
      for (const real of ["sk_test_1", "SG.real", "pat-real"]) expect(file.content).not.toContain(real);
    }
    expect(rendered.rules.map((rule) => rule.value).sort()).toEqual(["SG.real", "pat-real", "sk_test_1"]);
    expect(rendered.guardValues).toHaveLength(6);
  });
});

describe("hosts and places", () => {
  it("swaps into headers only unless the entry opts in to the query string or the body", async () => {
    const templateDir = await template({ ".env": "A={{secret:DEV_A@a.example}}\nB={{secret:DEV_B@b.example;query}}\nC={{secret:DEV_C@c.example ; body ; query}}\n" });

    const rendered = await renderOverlay({ templateDir, fetcher: fetcher({ DEV_A: "real-a", DEV_B: "real-b", DEV_C: "real-c" }) });

    expect(rendered.rules.map((rule) => [rule.value, rule.hosts, rule.swapIn])).toEqual([
      ["real-a", ["a.example"], ["headers"]],
      ["real-b", ["b.example"], ["headers", "query"]],
      ["real-c", ["c.example"], ["headers", "query", "body"]],
    ]);
  });

  it("refuses an unknown place and a wildcard over fewer than two labels", async () => {
    const templateDir = await template({ ".env": "A={{secret:DEV_A@a.example;cookies}}\nB={{secret:DEV_B@*.com}}\nC={{secret:DEV_C@*}}\nD={{secret:DEV_D@api.*.example}}\n" });

    expect(await overlayTemplateIssues(templateDir)).toEqual([
      '.env:1: {{secret:DEV_A@a.example;cookies}} names an unknown place "cookies"; only ;query and ;body may follow the hosts',
      '.env:2: {{secret:DEV_B@*.com}} names an invalid host "*.com"; use a host name or *.<domain> with at least two labels',
      '.env:3: {{secret:DEV_C@*}} names an invalid host "*"; use a host name or *.<domain> with at least two labels',
      '.env:4: {{secret:DEV_D@api.*.example}} names an invalid host "api.*.example"; use a host name or *.<domain> with at least two labels',
    ]);
  });

  it("warns about a wildcard on a domain anyone can have a subdomain of, not about its exact hosts", async () => {
    const templateDir = await template({
      ".env": "A={{secret:DEV_A@*.s3.amazonaws.com,*.stripe.com}}\nB={{secret:DEV_B@bucket.s3.amazonaws.com}}\nC={{secret:DEV_C@*.vercel.app}}\n",
    });

    const summary = await overlayTemplateSummary(templateDir);

    expect(summary.issues).toEqual([]);
    expect(summary.warnings).toEqual([
      ".env:1: DEV_A goes to *.s3.amazonaws.com, a domain anyone can have a subdomain of; name the exact host",
      ".env:3: DEV_C goes to *.vercel.app, a domain anyone can have a subdomain of; name the exact host",
    ]);
  });
});

describe("overlayTemplateIssues", () => {
  it("names every signed entry and secret without hosts, reading no secret", async () => {
    const templateDir = await template({ ".env": "A={{signed:DEV_X}}\nB={{secret:DEV_Y@a.example}}\n", "apps/web/.env": "C={{secret:DEV_Z}}\n" });

    expect(await overlayTemplateIssues(templateDir)).toEqual([
      ".env:1: DEV_X is used to sign requests; the egress proxy cannot stand in for it",
      "apps/web/.env:1: {{secret:DEV_Z}} names no hosts",
    ]);
  });
});

describe("overlayTemplateSummary", () => {
  it("counts the files and names each outbound secret id once, sorted, reading no secret", async () => {
    const templateDir = await template({
      ".env": "B={{secret:DEV_Y@a.example}}\nA={{secret:DEV_X@a.example,b.example}}\nL={{local}}\n",
      "apps/web/.env": "B={{secret:DEV_Y@a.example}}\nS={{signed:DEV_SIGN}}\n",
    });

    expect(await overlayTemplateSummary(templateDir)).toEqual({
      files: 2,
      secretIds: ["DEV_X", "DEV_Y"],
      issues: ["apps/web/.env:2: DEV_SIGN is used to sign requests; the egress proxy cannot stand in for it"],
      warnings: [],
    });
  });
});

describe("writeRenderedOverlay", () => {
  it("writes the agent files and the private rules and guard files", async () => {
    const templateDir = await template({ "apps/api/.env": "STRIPE_SECRET_KEY={{secret:DEV_S@api.stripe.com}}\n" });
    const rendered = await renderOverlay({ templateDir, fetcher: fetcher({ DEV_S: "sk_test_1" }) });
    const out = { agentOut: join(dir, "agent"), rulesOut: join(dir, "egress", "rules.json"), guardOut: join(dir, "guard", "guard.json") };

    await writeRenderedOverlay(rendered, out);

    expect(await readFile(join(out.agentOut, "apps/api/.env"), "utf8")).toBe(rendered.files[0]?.content);
    expect(JSON.parse(await readFile(out.rulesOut, "utf8"))).toEqual(rendered.rules);
    expect(JSON.parse(await readFile(out.guardOut, "utf8"))).toEqual(rendered.guardValues);
    expect((await stat(out.rulesOut)).mode & 0o777).toBe(0o600);
    expect((await stat(out.guardOut)).mode & 0o777).toBe(0o600);
  });
});
