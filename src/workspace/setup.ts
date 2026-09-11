import { execa } from "execa";

const keepTail = (text: string, tailBytes: number): string => {
  const bytes = Buffer.from(text, "utf8");
  return bytes.length <= tailBytes ? text : bytes.subarray(bytes.length - tailBytes).toString("utf8");
};

export const runSetup = async (
  commands: string[],
  cwd: string,
  env: Record<string, string>,
  opts: { timeoutMs: number; tailBytes: number },
): Promise<{ ok: boolean; tail: string }> => {
  const deadline = Date.now() + opts.timeoutMs;
  let output = "";
  for (const command of commands) {
    output = keepTail(`${output}$ ${command}\n`, opts.tailBytes);
    const remaining = Math.max(1, deadline - Date.now());
    const subprocess = execa(command, {
      cwd,
      env,
      extendEnv: false,
      shell: true,
      all: true,
      buffer: false,
      reject: false,
      timeout: remaining,
    });
    for await (const chunk of subprocess.all) {
      output = keepTail(output + String(chunk), opts.tailBytes);
    }
    const result = await subprocess;
    if (result.timedOut) {
      return { ok: false, tail: keepTail(`${output}[timed out]\n`, opts.tailBytes) };
    }
    if (result.exitCode !== 0) {
      return { ok: false, tail: keepTail(`${output}[exit ${result.exitCode ?? result.signal ?? "unknown"}]\n`, opts.tailBytes) };
    }
  }
  return { ok: true, tail: output };
};
