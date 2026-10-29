import { resolve } from "node:path";
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
 * The working tree pinned to the worktree itself: `GIT_WORK_TREE` wins over a `core.worktree` (or `core.bare`) the agent
 * sets in the git directory's config, which would otherwise have `status`, `diff` and `ls-files` read some other
 * directory of the steward's filesystem and hand its file names back in a refusal.
 */
export const workTreeEnv = (worktree: string): Record<string, string> => ({ GIT_WORK_TREE: resolve(worktree) });

/** Diff driver keys an empty value makes git refuse rather than run: `git diff` then fails instead of running the agent's program. */
const DIFF_DRIVER_KEYS: Array<[string, string]> = [
  ["textconv", ""],
  ["command", ""],
];

/** The driver names the worktree's config defines under `section` (`filter`, `diff`). Reading config runs nothing. */
const configuredDrivers = async (cwd: string, section: string): Promise<string[]> => {
  const listed = await git([...safeGitArgs(), "config", "--null", "--name-only", "--get-regexp", `^${section}\\.`], cwd, safeGitEnv());
  // Exit 1: nothing is configured.
  if (listed.exitCode !== 0) return [];
  const drivers = new Set(
    listed.stdout
      .split("\0")
      .filter((name) => name !== "")
      .map((name) => name.slice(section.length + 1, name.lastIndexOf(".")))
      .filter((driver) => driver !== ""),
  );
  return [...drivers];
};

const driverPairs = (section: string, drivers: string[], keys: Array<[string, string]>): Array<[string, string]> =>
  drivers.flatMap((driver) => keys.map(([key, value]): [string, string] => [`${section}.${driver}.${key}`, value]));

/**
 * Overrides switching off every filter driver the worktree's config defines (attributes can name one for any path, and git
 * runs its clean command when it compares a changed file). Read fresh on each call: the agent can add one at any time.
 */
export const filterOverrides = async (cwd: string): Promise<string[]> => asArgs(driverPairs("filter", await configuredDrivers(cwd, "filter"), FILTER_KEYS));

/**
 * The same overrides as environment (`GIT_CONFIG_COUNT`), for a program that runs git itself in the worktree (Orbit runs
 * `git status`, which applies clean filters). Read fresh on each call, like `filterOverrides`; it also disables every diff
 * driver's textconv and command, since the steward does not control the flags that program passes to `git diff`.
 * Remote URLs cannot be pinned this way (a `-c remote.origin.url` adds a URL after the worktree's own, and `insteadOf`
 * still rewrites it); Orbit takes its API host from `GITLAB_URL` and refuses a remote on another host.
 */
export const safeGitConfigEnv = async (cwd: string): Promise<Record<string, string>> => {
  const pairs = [
    ...SAFE_CONFIG,
    ...driverPairs("filter", await configuredDrivers(cwd, "filter"), FILTER_KEYS),
    ...driverPairs("diff", await configuredDrivers(cwd, "diff"), DIFF_DRIVER_KEYS),
  ];
  return {
    ...safeGitEnv(),
    ...workTreeEnv(cwd),
    GIT_CONFIG_COUNT: String(pairs.length),
    ...Object.fromEntries(pairs.flatMap(([key, value], index) => [[`GIT_CONFIG_KEY_${index}`, key], [`GIT_CONFIG_VALUE_${index}`, value]])),
  };
};

/**
 * `git` on an agent's worktree (`cwd`, its top directory): the safe overrides, every configured filter off, the working
 * tree pinned to `cwd`, and the safe env under `extraEnv`.
 */
export const safeGit = async (args: string[], cwd: string, extraEnv: Record<string, string> = {}): Promise<GitResult> =>
  git([...safeGitArgs(), ...(await filterOverrides(cwd)), ...args], cwd, { ...safeGitEnv(), ...workTreeEnv(cwd), ...extraEnv });

/** `gitOrThrow` on an agent's worktree, as `safeGit`. The message names the subcommand and scrubbed stderr only. */
export const safeGitOrThrow = async (args: string[], cwd: string, extraEnv: Record<string, string> = {}): Promise<string> => {
  const result = await safeGit(args, cwd, extraEnv);
  if (result.exitCode !== 0) throw new Error(`git ${args[0]} exited ${result.exitCode}: ${scrubCredentials(result.stderr)}`);
  return result.stdout;
};
