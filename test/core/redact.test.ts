import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { collectSecretValues, Redactor } from "../../src/core/redact.js";

describe("Redactor", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("replaces known secret values", () => {
    const redactor = new Redactor(["super-secret-value"]);
    expect(redactor.redact("token=super-secret-value; again super-secret-value")).toBe("token=***; again ***");
  });

  it("leaves short known values untouched", () => {
    const redactor = new Redactor(["short"]);
    expect(redactor.redact("a short word")).toBe("a short word");
  });

  it("replaces a glpat- token by pattern", () => {
    const redactor = new Redactor([]);
    expect(redactor.redact("using glpat-AbCdEfGhIjKlMnOpQrSt now")).toBe("using *** now");
  });

  it("replaces sk-, ghp_ and lin_oauth_ tokens by pattern", () => {
    const redactor = new Redactor([]);
    expect(redactor.redact("sk-abcdefghijklmnop ghp_ABCDEFGHIJKLMNOP lin_oauth_abcdefghijklmnop")).toBe("*** *** ***");
  });

  it("replaces credentials in postgres connection strings", () => {
    const redactor = new Redactor([]);
    expect(redactor.redact("postgres://steward:hunter22@db.local:5432/app")).toBe("postgres://***:***@db.local:5432/app");
  });

  it("consults a secret provider on every call", () => {
    const secrets: string[] = [];
    const redactor = new Redactor(() => secrets);
    expect(redactor.redact("token=rotated-token-value")).toBe("token=rotated-token-value");

    secrets.push("rotated-token-value");

    expect(redactor.redact("token=rotated-token-value")).toBe("token=***");
  });

  it("escapes regex characters in known values", () => {
    const redactor = new Redactor(["a.b+c(d)e"]);
    expect(redactor.redact("value a.b+c(d)e and aXb+c(d)e")).toBe("value *** and aXb+c(d)e");
  });
});

describe("collectSecretValues", () => {
  let dir: string;

  beforeEach(async () => {
    vi.restoreAllMocks();
    dir = await mkdtemp(join(tmpdir(), "steward-redact-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("collects defined secret values and credential-looking overlay values", async () => {
    const envFile = join(dir, ".env");
    await writeFile(
      envFile,
      [
        "DATABASE_URL=postgres://u:p@host/db",
        'STRIPE_SECRET="sk_test_abcdefgh"',
        "SMTP_PASSWORD=mailpass123",
        "APP_NAME=kickoff",
        "PORT=3000",
        "# comment",
      ].join("\n"),
    );
    const values = collectSecretValues({ LINEAR_CLIENT_SECRET: "linear-secret", MIRROR_TOKEN: undefined }, [envFile]);
    expect(values).toEqual(["linear-secret", "postgres://u:p@host/db", "sk_test_abcdefgh", "mailpass123"]);
  });

  it("returns only secret values when there are no overlay files", () => {
    expect(collectSecretValues({ GITLAB_TOKEN: "glpat-xyz" }, [])).toEqual(["glpat-xyz"]);
  });
});
