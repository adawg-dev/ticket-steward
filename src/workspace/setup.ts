import { execa } from "execa";

const keepTail = (text: string, tailBytes: number): string => {
  const bytes = Buffer.from(text, "utf8");
  return bytes.length <= tailBytes ? text : bytes.subarray(bytes.length - tailBytes).toString("utf8");
};

/** Kills the whole process group of a detached command, so children of the shell cannot outlive the deadline. */
const killGroup = (pid: number | undefined): void => {
  if (pid === undefined) return;
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    // group already gone
  }
};

export const runSetup = async (
  commands: string[],
  cwd: string,
  env: Record<string, string>,
  opts: { timeoutMs: number; tailBytes: number; signal?: AbortSignal },
): Promise<{ ok: boolean; tail: string }> => {
  const deadline = Date.now() + opts.timeoutMs;
  let output = "";
  const append = (text: string): void => {
    output = keepTail(output + text, opts.tailBytes);
  };
  for (const command of commands) {
    append(`$ ${command}\n`);
    const subprocess = execa(command, { cwd, env, extendEnv: false, shell: true, all: true, buffer: false, reject: false, detached: true });
    const stop = (): void => killGroup(subprocess.pid);
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      stop();
    }, Math.max(1, deadline - Date.now()));
    opts.signal?.addEventListener("abort", stop, { once: true });
    if (opts.signal?.aborted) stop();
    for await (const chunk of subprocess.all) append(String(chunk));
    const result = await subprocess;
    clearTimeout(timer);
    opts.signal?.removeEventListener("abort", stop);
    if (opts.signal?.aborted) {
      append("[interrupted]\n");
      return { ok: false, tail: output };
    }
    if (timedOut) {
      append("[timed out]\n");
      return { ok: false, tail: output };
    }
    if (result.exitCode !== 0) {
      append(`[exit ${result.exitCode ?? result.signal ?? "unknown"}]\n`);
      return { ok: false, tail: output };
    }
  }
  return { ok: true, tail: output };
};
