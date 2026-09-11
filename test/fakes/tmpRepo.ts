import { mkdir, realpath, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { join } from "node:path";
import { Mirror } from "../../src/workspace/mirror.js";
import { commitFile, makeSourceRepo, tmpDir } from "../workspace/helpers.js";

export interface TmpRepo {
  root: string;
  dataDir: string;
  overlayDir: string;
  promptPath: string;
  repo: string;
  sha: string;
  mirror: Mirror;
  cleanup: () => Promise<void>;
}

export const freeTcpPort = (): Promise<number> =>
  new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, () => {
      const address = server.address();
      const port = address !== null && typeof address === "object" ? address.port : 0;
      server.close(() => resolve(port));
    });
  });

/** A real source repo on `main`, a steward-owned bare mirror of it, an empty overlay and a prompt template. */
export const tmpRepo = async (promptTemplate: string): Promise<TmpRepo> => {
  const root = await realpath(await tmpDir());
  const { repo } = await makeSourceRepo(root);
  const sha = await commitFile(repo, "src/adapter.ts", "export const adapter = 1;\n");
  const dataDir = join(root, "data");
  const overlayDir = join(root, "overlay");
  const promptPath = join(root, "prompt.md");
  await mkdir(dataDir, { recursive: true, mode: 0o700 });
  await mkdir(overlayDir, { recursive: true, mode: 0o700 });
  await writeFile(promptPath, promptTemplate);
  const mirror = await Mirror.init(join(dataDir, "repo.git"), repo);
  return {
    root,
    dataDir,
    overlayDir,
    promptPath,
    repo,
    sha,
    mirror,
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
};
