import { existsSync } from "node:fs";
import { copyFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";

import { listFiles } from "./files.js";

export const copySkills = async (skillsDir: string | undefined, worktreePath: string): Promise<string[]> => {
  if (skillsDir === undefined || !existsSync(skillsDir)) return [];
  const files = await listFiles(skillsDir);
  const target = join(worktreePath, ".claude", "skills");
  for (const file of files) {
    await mkdir(dirname(join(target, file)), { recursive: true });
    await copyFile(join(skillsDir, file), join(target, file));
  }
  return files;
};
