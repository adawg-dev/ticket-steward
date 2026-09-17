import { readdir } from "node:fs/promises";
import { join, relative } from "node:path";

/** Relative paths of every regular file under `dir`, sorted, skipping `skipDirs` by basename. */
export const listFiles = async (dir: string, skipDirs: string[] = []): Promise<string[]> => {
  const files: string[] = [];
  const walk = async (current: string): Promise<void> => {
    const entries = await readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      const full = join(current, entry.name);
      if (entry.isDirectory()) {
        if (!skipDirs.includes(entry.name)) await walk(full);
      } else if (entry.isFile()) {
        files.push(relative(dir, full));
      }
    }
  };
  await walk(dir);
  return files.sort();
};
