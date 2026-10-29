import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { kubernetesRuntime, type StewardConfig } from "../config/schema.js";
import { ADMIN_HOST, ADMIN_PORT, ADMIN_TOKEN_FILE } from "../server/admin.js";
import { SettingsSchema, type Settings, type SettingsPatch } from "../settings/schema.js";
import type { TemplateListing, TicketBundle } from "../tracker/types.js";
import type { CliContext } from "./context.js";

const PROBE_TIMEOUT_MS = 2_000;

/** The admin API answered with an error; `message` is its own. */
export class AdminError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

const JobSummarySchema = z.looseObject({
  id: z.number(),
  status: z.string(),
  identifier: z.string(),
  kind: z.string(),
  attempts: z.number(),
  createdAt: z.string(),
});

const LoopViewSchema = z.looseObject({
  id: z.number(),
  state: z.string(),
  round: z.number(),
  mrUrl: z.string().nullable(),
  history: z.array(
    z.object({
      round: z.number(),
      score: z.number().nullable(),
      headSha: z.string(),
      pipeline: z.string().nullable(),
      fixed: z.number(),
      declined: z.number(),
      outcome: z.string(),
    }),
  ),
});

const JobDetailSchema = z.object({
  job: JobSummarySchema,
  attempts: z.array(z.looseObject({ transcriptPath: z.string().nullable() })),
  loop: LoopViewSchema.nullable(),
});

const TicketBundleSchema: z.ZodType<TicketBundle> = z.object({
  id: z.string(),
  identifier: z.string(),
  url: z.string(),
  title: z.string(),
  description: z.string(),
  team: z.object({ id: z.string(), key: z.string(), name: z.string() }),
  state: z.object({ name: z.string(), type: z.string() }),
  labels: z.array(z.string()),
  priority: z.number(),
  creator: z.object({ name: z.string(), isBot: z.boolean() }).nullable(),
  createdAt: z.string(),
  comments: z.array(z.object({ author: z.string(), body: z.string(), createdAt: z.string() })),
  attachments: z.array(z.object({ title: z.string(), url: z.string() })),
  appliedTemplate: z.string().nullable(),
  templates: z.array(z.object({ name: z.string(), description: z.string(), body: z.string(), requiredFields: z.array(z.string()) })),
});

const TemplateListingSchema: z.ZodType<TemplateListing> = z.object({
  scope: z.string(),
  template: z.object({ name: z.string(), description: z.string(), body: z.string(), requiredFields: z.array(z.string()) }),
});

const ChatOpenedSchema = z.object({ runId: z.string(), pod: z.string(), container: z.string(), leaseId: z.number() });
const ChatClosedSchema = z.object({ released: z.boolean(), ok: z.boolean().nullable(), error: z.string().nullable(), unpushed: z.string().nullable() });
const ErrorBody = z.object({ error: z.string() });

/** What the CLI prints of a job (`steward jobs`); the API sends the whole row. */
export interface JobSummary {
  id: number;
  status: string;
  identifier: string;
  kind: string;
  attempts: number;
  createdAt: string;
}

/** What the CLI prints of a loop (`steward jobs show`). */
export interface LoopView {
  id: number;
  state: string;
  round: number;
  mrUrl: string | null;
  history: Array<{ round: number; score: number | null; headSha: string; pipeline: string | null; fixed: number; declined: number; outcome: string }>;
}

export type JobDetail = z.infer<typeof JobDetailSchema>;
export type ChatOpened = z.infer<typeof ChatOpenedSchema>;
export type ChatClosed = z.infer<typeof ChatClosedSchema>;

/** The dispatcher's admin API as the CLI uses it (`src/server/admin.ts`). */
export interface AdminClient {
  listJobs(p: { status?: string; limit: number }): Promise<JobSummary[]>;
  /** Null when there is no such job. */
  job(id: number): Promise<JobDetail | null>;
  /** Requeues the job; resolves to what the retry will do. */
  retry(id: number): Promise<string>;
  openChat(key: string, pid: number): Promise<ChatOpened>;
  /** False when no chat holds the ticket any more. */
  heartbeat(key: string): Promise<boolean>;
  closeChat(key: string): Promise<ChatClosed>;
  /** The ticket (issue key or UUID) as the dispatcher reads it from Linear; the CLI holds no Linear token. */
  ticketBundle(key: string): Promise<TicketBundle>;
  /** The issue templates of the workspace and the allowlisted teams, as the dispatcher reads them from Linear. */
  templates(): Promise<TemplateListing[]>;
  /** The runtime settings in effect. */
  settings(): Promise<Settings>;
  /** Applies the patch (audited as `admin-cli`); resolves to the settings now in effect. */
  setSettings(patch: SettingsPatch): Promise<Settings>;
}

export const adminClient = (fetchImpl: typeof fetch, p: { token: string; port?: number }): AdminClient => {
  const base = `http://${ADMIN_HOST}:${p.port ?? ADMIN_PORT}`;

  const request = async <T>(schema: z.ZodType<T>, method: string, path: string, body?: unknown): Promise<T> => {
    const headers: Record<string, string> = { authorization: `Bearer ${p.token}` };
    if (body !== undefined) headers["content-type"] = "application/json";
    const response = await fetchImpl(`${base}${path}`, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const json: unknown = await response.json().catch(() => null);
    if (!response.ok) {
      const parsed = ErrorBody.safeParse(json);
      throw new AdminError(response.status, parsed.success ? parsed.data.error : `the admin API answered ${response.status}`);
    }
    return schema.parse(json);
  };

  const ticketPath = (key: string): string => `/api/chat/${encodeURIComponent(key)}`;

  return {
    listJobs: async ({ status, limit }) => {
      const query = new URLSearchParams({ limit: String(limit), ...(status === undefined ? {} : { status }) });
      return (await request(z.object({ jobs: z.array(JobSummarySchema) }), "GET", `/api/jobs?${query.toString()}`)).jobs;
    },
    job: async (id) => {
      try {
        return await request(JobDetailSchema, "GET", `/api/jobs/${id}`);
      } catch (err) {
        if (err instanceof AdminError && err.status === 404) return null;
        throw err;
      }
    },
    retry: async (id) => (await request(z.object({ mode: z.string() }), "POST", `/api/jobs/${id}/retry`)).mode,
    openChat: (key, pid) => request(ChatOpenedSchema, "POST", ticketPath(key), { pid }),
    heartbeat: async (key) => {
      try {
        await request(z.object({ ok: z.literal(true) }), "POST", `${ticketPath(key)}/heartbeat`);
        return true;
      } catch (err) {
        if (err instanceof AdminError && err.status === 404) return false;
        throw err;
      }
    },
    closeChat: (key) => request(ChatClosedSchema, "DELETE", ticketPath(key)),
    ticketBundle: (key) => request(TicketBundleSchema, "GET", `/api/tickets/${encodeURIComponent(key)}/bundle`),
    templates: async () => (await request(z.object({ templates: z.array(TemplateListingSchema) }), "GET", "/api/templates")).templates,
    settings: () => request(SettingsSchema, "GET", "/api/settings"),
    setSettings: (patch) => request(SettingsSchema, "PATCH", "/api/settings", patch),
  };
};

/**
 * The admin API when it answers: on the Kubernetes runtime, with the token `serve` wrote to the runtime dir. Null on the
 * local runtime (the Compose host), without a token file, or when nothing listens on the port; the CLI then opens the DB.
 * An API that answers but refuses the token is an error, not a fallback.
 */
export const connectAdmin = async (
  ctx: Pick<CliContext, "fetchImpl">,
  config: Pick<StewardConfig, "runtime">,
  opts: { port?: number } = {},
): Promise<AdminClient | null> => {
  const runtime = kubernetesRuntime(config);
  if (runtime === null) return null;
  const tokenFile = join(runtime.runtimeDir, ADMIN_TOKEN_FILE);
  let token: string;
  try {
    token = (await readFile(tokenFile, "utf8")).trim();
  } catch {
    return null;
  }
  if (token === "") return null;
  let response: Response;
  try {
    response = await ctx.fetchImpl(`http://${ADMIN_HOST}:${opts.port ?? ADMIN_PORT}/api/ping`, {
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
  } catch {
    return null;
  }
  if (response.status === 401) throw new Error(`the admin API refused the token in ${tokenFile}; it is rewritten at each start of steward serve`);
  if (!response.ok) throw new AdminError(response.status, `the admin API answered ${response.status}`);
  return adminClient(ctx.fetchImpl, { token, ...(opts.port === undefined ? {} : { port: opts.port }) });
};
