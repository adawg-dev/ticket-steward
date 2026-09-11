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

/** Runs git with the steward's hardened environment; never throws on a non-zero exit. */
export const git = async (args: string[], cwd?: string): Promise<GitResult> => {
  const result = await execa("git", args, {
    ...(cwd === undefined ? {} : { cwd }),
    env: gitEnvRecord(),
    extendEnv: false,
    reject: false,
  });
  return { exitCode: result.exitCode ?? 1, stdout: result.stdout.trim(), stderr: result.stderr.trim() };
};

/** Runs git and throws when it exits non-zero. */
export const gitOrThrow = async (args: string[], cwd?: string): Promise<string> => {
  const result = await git(args, cwd);
  if (result.exitCode !== 0) {
    throw new Error(`git ${args.join(" ")} exited ${result.exitCode}: ${result.stderr}`);
  }
  return result.stdout;
};
