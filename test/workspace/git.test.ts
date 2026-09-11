import { join } from "node:path";

import { gitOrThrow, scrubCredentials } from "../../src/workspace/git.js";
import { removeDir, tmpDir } from "./helpers.js";

const TOKEN = "glpat-SECRET";

describe("scrubCredentials", () => {
  it("masks user:password in URLs", () => {
    expect(scrubCredentials(`fatal: could not read from https://oauth2:${TOKEN}@gitlab.com/g/r.git and http://x-access-token:${TOKEN}@github.com/o/r`)).toBe(
      "fatal: could not read from https://***@gitlab.com/g/r.git and http://***@github.com/o/r",
    );
  });

  it("leaves credential-free text unchanged", () => {
    expect(scrubCredentials("fatal: not a git repository")).toBe("fatal: not a git repository");
  });
});

describe("gitOrThrow", () => {
  let root: string;

  beforeEach(async () => {
    vi.restoreAllMocks();
    root = await tmpDir();
  });

  afterEach(async () => {
    await removeDir(root);
  });

  it("returns stdout on success", async () => {
    await gitOrThrow(["init", "-q", "-b", "main"], root);

    expect(await gitOrThrow(["symbolic-ref", "--short", "HEAD"], root)).toBe("main");
  });

  it("never puts the tokenized URL argument into the thrown message", async () => {
    const tokenized = `https://oauth2:${TOKEN}@127.0.0.1:1/group/repo.git`;

    const failure = await gitOrThrow(["clone", "--quiet", "--mirror", tokenized, join(root, "repo.git")]).then(
      () => null,
      (err: unknown) => err,
    );

    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).not.toContain(TOKEN);
    expect((failure as Error).message).not.toContain(tokenized);
  });
});
