/** One doctor check and its outcome; any `fail` makes doctor exit 1. */
export type Level = "ok" | "fail" | "warn";

export interface CheckResult {
  level: Level;
  message: string;
}

export interface Check {
  name: string;
  run: () => Promise<CheckResult>;
}

export const ok = (message: string): CheckResult => ({ level: "ok", message });
export const flunk = (message: string): CheckResult => ({ level: "fail", message });
export const warn = (message: string): CheckResult => ({ level: "warn", message });
