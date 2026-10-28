import { git, scrubCredentials, type GitResult } from "../workspace/git.js";

/**
 * Command-line config (highest precedence) that undoes what an agent can set in a worktree's config to run a program or
 * reach another remote when the steward runs git there: the fsmonitor and hooks, ssh and external diff commands,
 * signature checks in `log`, submodule status runs, and every transport but local files. `url.*.insteadOf` and
 * `http.proxy` only matter when git reaches a remote, which these overrides forbid; pushes go from a scratch repo.
 */
const SAFE_CONFIG: Array<[string, string]> = [
  ["core.fsmonitor", "false"],
  ["core.hooksPath", "/dev/null"],
  ["core.sshCommand", ""],
  ["diff.external", ""],
  ["log.showSignature", "false"],
  ["diff.ignoreSubmodules", "dirty"],
  ["submodule.recurse", "false"],
  ["protocol.allow", "never"],
  ["protocol.file.allow", "always"],
];

/** Filter driver keys an empty (or false) value switches off. */
const FILTER_KEYS: Array<[string, string]> = [
  ["clean", ""],
  ["smudge", ""],
  ["process", ""],
  ["required", "false"],
];

const asArgs = (pairs: Array<[string, string]>): string[] => pairs.flatMap(([key, value]) => ["-c", `${key}=${value}`]);

/** The `-c` overrides every git call on an agent's worktree runs with. */
export const safeGitArgs = (): string[] => asArgs(SAFE_CONFIG);

/** No system or global config or attributes, and no replace refs, so git reads the real objects. */
export const safeGitEnv = (): Record<string, string> => ({ GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_NO_REPLACE_OBJECTS: "1", GIT_ATTR_NOSYSTEM: "1" });

/**
 * The same overrides as environment (`GIT_CONFIG_COUNT`), for a program that runs git itself in the worktree (Orbit).
 * Filters are not covered: their driver names are only known by reading the worktree's config.
 */
export const safeGitConfigEnv = (): Record<string, string> => ({
  ...safeGitEnv(),
  GIT_CONFIG_COUNT: String(SAFE_CONFIG.length),
  ...Object.fromEntries(SAFE_CONFIG.flatMap(([key, value], index) => [[`GIT_CONFIG_KEY_${index}`, key], [`GIT_CONFIG_VALUE_${index}`, value]])),
});

/**
 * Overrides switching off every filter driver the worktree's config defines (attributes can name one for any path, and git
 * runs its clean command when it compares a changed file). Read fresh on each call: the agent can add one at any time.
 * Reading config runs nothing.
 */
export const filterOverrides = async (cwd: string): Promise<string[]> => {
  const listed = await git([...safeGitArgs(), "config", "--null", "--name-only", "--get-regexp", "^filter\\."], cwd, safeGitEnv());
  // Exit 1: no filter is configured.
  if (listed.exitCode !== 0) return [];
  const drivers = new Set(
    listed.stdout
      .split("\0")
      .filter((name) => name !== "")
      .map((name) => name.slice("filter.".length, name.lastIndexOf(".")))
      .filter((driver) => driver !== ""),
  );
  return [...drivers].flatMap((driver) => asArgs(FILTER_KEYS.map(([key, value]) => [`filter.${driver}.${key}`, value])));
};

/** `git` on an agent's worktree: the safe overrides, every configured filter off, and the safe env under `extraEnv`. */
export const safeGit = async (args: string[], cwd: string, extraEnv: Record<string, string> = {}): Promise<GitResult> =>
  git([...safeGitArgs(), ...(await filterOverrides(cwd)), ...args], cwd, { ...safeGitEnv(), ...extraEnv });

/** `gitOrThrow` on an agent's worktree, as `safeGit`. The message names the subcommand and scrubbed stderr only. */
export const safeGitOrThrow = async (args: string[], cwd: string, extraEnv: Record<string, string> = {}): Promise<string> => {
  const result = await safeGit(args, cwd, extraEnv);
  if (result.exitCode !== 0) throw new Error(`git ${args[0]} exited ${result.exitCode}: ${scrubCredentials(result.stderr)}`);
  return result.stdout;
};
