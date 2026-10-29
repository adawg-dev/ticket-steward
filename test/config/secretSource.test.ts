import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ResourceNotFoundException } from "@aws-sdk/client-secrets-manager";
import { awsSecretFetcher, loadSecretsFrom, parseSecretValue } from "../../src/config/secretSource.js";
import type { SecretFetcher } from "../../src/config/secretSource.js";

const aws = (map: Record<string, string>) => ({ source: "aws" as const, region: "us-west-2", map });

/** Serves `values` by id; anything else is not found. Records the ids asked for, in order. */
const fakeFetcher = (values: Record<string, string>): SecretFetcher & { asked: string[] } => {
  const asked: string[] = [];
  return { asked, get: async (id) => { asked.push(id); return values[id] ?? null; } };
};

describe("parseSecretValue", () => {
  it("reads a JSON secret's first value and a raw secret as is", () => {
    expect(parseSecretValue('{"STRIPE_SECRET_KEY":"sk_test_1"}')).toBe("sk_test_1");
    expect(parseSecretValue("plain-value\n")).toBe("plain-value");
  });

  it("keeps JSON that is not an object with a value as the raw string", () => {
    expect(parseSecretValue("{}")).toBe("{}");
    expect(parseSecretValue('["a"]')).toBe('["a"]');
    expect(parseSecretValue("42")).toBe("42");
    expect(parseSecretValue('"quoted"')).toBe('"quoted"');
  });

  it("stringifies a non-string first value", () => {
    expect(parseSecretValue('{"PORT":5432}')).toBe("5432");
  });

  it("strips only trailing newlines", () => {
    expect(parseSecretValue("  spaced  \n\n")).toBe("  spaced  ");
  });
});

describe("loadSecretsFrom", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "steward-secrets-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("maps env names to secret ids and fails naming the id, never a value", async () => {
    const fetcher = fakeFetcher({ DEV_A: '{"A":"one"}', DEV_EMPTY: "", DEV_EMPTY_JSON: '{"B":""}' });
    expect(await loadSecretsFrom(aws({ GITLAB_TOKEN: "DEV_A" }), "/cfg", fetcher)).toMatchObject({ GITLAB_TOKEN: "one" });
    await expect(loadSecretsFrom(aws({ X: "DEV_MISSING" }), "/cfg", fetcher)).rejects.toThrow("DEV_MISSING not found");
    await expect(loadSecretsFrom(aws({ X: "DEV_EMPTY" }), "/cfg", fetcher)).rejects.toThrow("DEV_EMPTY is empty");
    await expect(loadSecretsFrom(aws({ X: "DEV_EMPTY_JSON" }), "/cfg", fetcher)).rejects.toThrow("DEV_EMPTY_JSON is empty");
  });

  it("gets each secret in turn and keeps only known secret names", async () => {
    const fetcher = fakeFetcher({ DEV_GL: "glpat-x", DEV_PUSH: '{"GITLAB_PUSH_TOKEN":"glpat-push"}', DEV_OTHER: "other" });
    const secrets = await loadSecretsFrom(aws({ GITLAB_TOKEN: "DEV_GL", GITLAB_PUSH_TOKEN: "DEV_PUSH", NOT_A_SECRET: "DEV_OTHER" }), dir, fetcher);
    expect(secrets).toEqual({ GITLAB_TOKEN: "glpat-x", GITLAB_PUSH_TOKEN: "glpat-push" });
    expect(fetcher.asked).toEqual(["DEV_GL", "DEV_PUSH", "DEV_OTHER"]);
  });

  it("does not read .env when the source is aws", async () => {
    await writeFile(join(dir, ".env"), "LINEAR_CLIENT_SECRET=from-env-file\n");
    expect(await loadSecretsFrom(aws({ GITLAB_TOKEN: "DEV_GL" }), dir, fakeFetcher({ DEV_GL: "glpat-x" }))).toEqual({ GITLAB_TOKEN: "glpat-x" });
  });

  it("keeps reading .env when the source is file, without asking the fetcher", async () => {
    await writeFile(join(dir, ".env"), "LINEAR_CLIENT_SECRET=lin-secret-test\nSOMETHING_ELSE=nope\n");
    const fetcher = fakeFetcher({});
    expect(await loadSecretsFrom({ source: "file" }, dir, fetcher)).toEqual({ LINEAR_CLIENT_SECRET: "lin-secret-test" });
    expect(fetcher.asked).toEqual([]);
  });

  it("reads no secrets from a missing .env", async () => {
    expect(await loadSecretsFrom({ source: "file" }, dir)).toEqual({});
  });
});

describe("awsSecretFetcher", () => {
  /** A Secrets Manager client stand-in that answers every GetSecretValue with `reply`. */
  const client = (reply: () => Promise<{ SecretString?: string }>) => {
    const ids: unknown[] = [];
    return { ids, send: async (command: { input: { SecretId?: string | undefined } }) => { ids.push(command.input.SecretId); return reply(); } };
  };

  it("returns the secret string of the id asked for", async () => {
    const fake = client(async () => ({ SecretString: '{"A":"one"}' }));
    expect(await awsSecretFetcher("us-west-2", fake).get("DEV_A")).toBe('{"A":"one"}');
    expect(fake.ids).toEqual(["DEV_A"]);
  });

  it("returns null for a secret that does not exist", async () => {
    const fake = client(async () => { throw new ResourceNotFoundException({ message: "not found", $metadata: {} }); });
    expect(await awsSecretFetcher("us-west-2", fake).get("DEV_MISSING")).toBeNull();
  });

  it("fails naming the id for a binary secret and for other errors", async () => {
    await expect(awsSecretFetcher("us-west-2", client(async () => ({}))).get("DEV_BIN")).rejects.toThrow("DEV_BIN has no string value");
    const denied = client(async () => { throw new Error("AccessDeniedException: not authorized"); });
    await expect(awsSecretFetcher("us-west-2", denied).get("DEV_A")).rejects.toThrow("Secrets Manager: reading DEV_A failed: AccessDeniedException: not authorized");
  });
});
