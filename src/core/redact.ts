import { readFileSync } from "node:fs";
import { parse } from "dotenv";

const MIN_SECRET_LENGTH = 8;
const MASK = "***";
const SECRET_KEY = /(KEY|TOKEN|SECRET|PASSWORD|PASS|CONN_STR|URL)$/i;

const TOKEN_PATTERNS: RegExp[] = [
  /\bsk-[A-Za-z0-9_-]{8,}/g,
  /\bglpat-[A-Za-z0-9_-]{8,}/g,
  /\bghp_[A-Za-z0-9]{8,}/g,
  /\blin_oauth_[A-Za-z0-9]{8,}/g,
];
const DB_URL_CREDENTIALS = /(postgres(?:ql)?:\/\/)[^\s:/@]+:[^\s@]+@/g;

const escapeRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export class Redactor {
  private readonly known: RegExp | null;

  constructor(knownSecrets: string[]) {
    const values = [...new Set(knownSecrets.filter((value) => value.length >= MIN_SECRET_LENGTH))].sort(
      (a, b) => b.length - a.length,
    );
    this.known = values.length === 0 ? null : new RegExp(values.map(escapeRegExp).join("|"), "g");
  }

  redact(text: string): string {
    const withoutKnown = this.known === null ? text : text.replace(this.known, MASK);
    const withoutTokens = TOKEN_PATTERNS.reduce((acc, pattern) => acc.replace(pattern, MASK), withoutKnown);
    return withoutTokens.replace(DB_URL_CREDENTIALS, `$1${MASK}:${MASK}@`);
  }
}

export const collectSecretValues = (
  secrets: Record<string, string | undefined>,
  overlayFiles: string[],
): string[] => {
  const fromSecrets = Object.values(secrets).filter((value): value is string => value !== undefined && value !== "");
  const fromOverlay = overlayFiles.flatMap((file) =>
    Object.entries(parse(readFileSync(file, "utf8")))
      .filter(([key, value]) => SECRET_KEY.test(key) && value !== "")
      .map(([, value]) => value),
  );
  return [...new Set([...fromSecrets, ...fromOverlay])];
};
