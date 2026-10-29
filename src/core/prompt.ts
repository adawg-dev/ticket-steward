import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import Mustache from "mustache";

const { render } = Mustache;

const verbatim = (value: string): string => value;

/**
 * Fill a prompt template: mustache, unescaped (the prompts are Markdown, not HTML), with the repo's own section as the
 * partial `{{> repo}}` on a line of its own. An empty `repo` renders nothing, not even the tag's line; any other ends in
 * one blank line, so the next section keeps its spacing whatever the file ends with.
 */
export const renderPrompt = (template: string, view: object, repo = ""): string => {
  const section = repo.trim() === "" ? "" : `${repo.trimEnd()}\n\n`;
  return render(template, view, { repo: section }, { escape: verbatim });
};

const isMissing = (err: unknown): boolean => err instanceof Error && "code" in err && err.code === "ENOENT";

/** The repo's own prompt section: `prompts/repo.md` in the config directory, or empty when the config has none. */
export const readRepoPartial = async (configPath: string): Promise<string> => {
  try {
    return await readFile(join(dirname(configPath), "prompts", "repo.md"), "utf8");
  } catch (err) {
    if (isMissing(err)) return "";
    throw err;
  }
};
