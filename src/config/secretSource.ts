import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { GetSecretValueCommand, SecretsManagerClient } from "@aws-sdk/client-secrets-manager";
import { parse } from "dotenv";
import { z } from "zod";
import type { SecretsConfig } from "./schema.js";

export const SecretsSchema = z.object({
  /** The steward's Linear OAuth app (client-credentials grant); Secrets Manager DEV_STEWARD_LINEAR_CLIENT_ID / _SECRET. */
  LINEAR_CLIENT_ID: z.string().optional(),
  LINEAR_CLIENT_SECRET: z.string().optional(),
  LINEAR_WEBHOOK_SECRET: z.string().optional(),
  MIRROR_TOKEN: z.string().optional(),
  MIRROR_USERNAME: z.string().optional(),
  GITLAB_TOKEN: z.string().optional(),
  GITLAB_WEBHOOK_SECRET: z.string().optional(),
  GITLAB_WEBHOOK_SIGNING_TOKEN: z.string().optional(),
  GITLAB_PUSH_TOKEN: z.string().optional(),
  GITHUB_TOKEN: z.string().optional(),
  ANTHROPIC_API_KEY: z.string().optional(),
  ANTHROPIC_AUTH_TOKEN: z.string().optional(),
  ANTHROPIC_BASE_URL: z.string().optional(),
  CLAUDE_CODE_OAUTH_TOKEN: z.string().optional(),
  OPENAI_API_KEY: z.string().optional(),
  OPENAI_BASE_URL: z.string().optional(),
});
export type Secrets = z.infer<typeof SecretsSchema>;
export type SecretName = keyof Secrets;

/** Reads one secret's stored string by id; null when no such secret exists. */
export interface SecretFetcher {
  get(id: string): Promise<string | null>;
}

/** The part of SecretsManagerClient the fetcher uses, so tests can stand in for it. */
export interface GetSecretValueClient {
  send(command: GetSecretValueCommand): Promise<{ SecretString?: string | undefined }>;
}

/**
 * Secrets Manager through the SDK's default credential chain, which in a pod assumes `AWS_ROLE_ARN` with the
 * projected service-account token at `AWS_WEB_IDENTITY_TOKEN_FILE`. Errors name the id; no value reaches a message.
 */
export const awsSecretFetcher = (region: string, client: GetSecretValueClient = new SecretsManagerClient({ region })): SecretFetcher => ({
  get: async (id) => {
    let secretString: string | undefined;
    try {
      ({ SecretString: secretString } = await client.send(new GetSecretValueCommand({ SecretId: id })));
    } catch (error) {
      if (error instanceof Error && error.name === "ResourceNotFoundException") return null;
      throw new Error(`Secrets Manager: reading ${id} failed: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
    }
    if (secretString === undefined) throw new Error(`Secrets Manager: ${id} has no string value`);
    return secretString;
  },
});

/** As kickoff's preview.py `fetch_secrets`: a JSON object's first value as a string, otherwise the raw string, trailing newlines dropped. */
export const parseSecretValue = (raw: string): string => {
  const value = raw.replace(/\n+$/, "");
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return value;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return value;
  const [first] = Object.values(parsed);
  if (first === undefined) return value;
  return typeof first === "string" ? first : JSON.stringify(first);
};

/** One secret's parsed value; missing or empty is an error naming the id, never a value. */
export const readSecretValue = async (fetcher: SecretFetcher, id: string): Promise<string> => {
  const raw = await fetcher.get(id);
  if (raw === null) throw new Error(`Secrets Manager: ${id} not found`);
  const value = parseSecretValue(raw);
  if (value === "") throw new Error(`Secrets Manager: ${id} is empty`);
  return value;
};

const pick = (values: Record<string, string>, only: readonly SecretName[] | undefined): Record<string, string> =>
  only === undefined ? values : Object.fromEntries(Object.entries(values).filter(([name]) => (only as readonly string[]).includes(name)));

/**
 * The steward's secrets: the config dir's `.env`, or each mapped Secrets Manager id in turn. With `only`, just those
 * names: a run pod's sidecar or init container holds (and reads from Secrets Manager) the credentials it uses and no
 * other.
 */
export const loadSecretsFrom = async (config: SecretsConfig, configDir: string, fetcher?: SecretFetcher, only?: readonly SecretName[]): Promise<Secrets> => {
  if (config.source === "file") {
    const raw = await readFile(join(configDir, ".env"), "utf8").catch(() => "");
    return SecretsSchema.parse(pick(parse(raw), only));
  }
  const source = fetcher ?? awsSecretFetcher(config.region);
  const values: Record<string, string> = {};
  for (const [name, id] of Object.entries(pick(config.map, only))) values[name] = await readSecretValue(source, id);
  return SecretsSchema.parse(values);
};
