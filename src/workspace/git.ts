import { execa } from "execa";

export interface GitEnv {
  GIT_CONFIG_GLOBAL: "/dev/null";
  GIT_TERMINAL_PROMPT: "0";
  PATH: string;
  HOME: string;
}

export const gitEnv = (): GitEnv => ({
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_TERMINAL_PROMPT: "0",
  PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
  HOME: process.env.HOME ?? "/nonexistent",
});

/** `gitEnv()` as a plain record, the shape child-process `env` options accept. */
export const gitEnvRecord = (): Record<string, string> => ({ ...gitEnv() });

export interface GitResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/** Masks `scheme://user:password@` credentials embedded in URLs. */
export const scrubCredentials = (text: string): string => text.replace(/:\/\/[^/@\s]+@/g, "://***@");

/** Runs git with the steward's hardened environment plus `extraEnv`; never throws on a non-zero exit. */
export const git = async (args: string[], cwd?: string, extraEnv: Record<string, string> = {}): Promise<GitResult> => {
  const result = await execa("git", args, {
    ...(cwd === undefined ? {} : { cwd }),
    env: { ...gitEnvRecord(), ...extraEnv },
    extendEnv: false,
    reject: false,
  });
  return { exitCode: result.exitCode ?? 1, stdout: result.stdout.trim(), stderr: result.stderr.trim() };
};

/** Runs git and throws when it exits non-zero. The message names the subcommand and scrubbed stderr only, never the arguments. */
export const gitOrThrow = async (args: string[], cwd?: string, extraEnv: Record<string, string> = {}): Promise<string> => {
  const result = await git(args, cwd, extraEnv);
  if (result.exitCode !== 0) {
    throw new Error(`git ${args[0]} exited ${result.exitCode}: ${scrubCredentials(result.stderr)}`);
  }
  return result.stdout;
};
