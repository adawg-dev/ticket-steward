import { createHash } from "node:crypto";
import type { StewardConfig } from "../config/schema.js";
import type { Secrets } from "../config/secretSource.js";
import type { Redactor } from "../core/redact.js";
import type { PipelineDeps } from "../core/deps.js";
import { logger } from "../log.js";
import { DEFAULT_SETTINGS } from "../settings/schema.js";
import type { NewDecision } from "../store/decisions.js";
import { createDecisionsClient, MAX_INPUT_CHARS, type DecisionsClient, type Question } from "./client.js";

type AskDeps = Pick<PipelineDeps, "decisions" | "stores" | "settings" | "redactor">;
type Where = Omit<NewDecision, "answer" | "inputChars" | "inputSha256">;

/** Asked once per ticket, on its first implement (spec: decisions-shadow-mode, "Intake"). */
export const INTAKE_QUESTIONS: Question[] = [
  {
    type: "predicate",
    name: "ready",
    instructions:
      "A competent engineer who knows the codebase could implement this ticket without asking anyone a question: the expected behaviour is clear, there is one reasonable reading, and no product decision is left open.",
  },
  {
    type: "choice",
    name: "workflow",
    instructions: "What kind of work this ticket is.",
    choices: [
      { value: "small", description: "A contained change: one area, obvious approach, a few files. No plan needed." },
      { value: "standard", description: "Normal feature or fix work across a few areas, with a clear approach. Worth a short plan." },
      {
        value: "design",
        description:
          "Needs a design before code: architectural, cross-cutting, ambiguous, or touching auth/RBAC, multi-tenancy, billing/credits or database migrations.",
      },
    ],
  },
];

const present = (value: string | undefined): value is string => value !== undefined && value !== "";

const hostOf = (url: string | undefined): string | null => {
  if (!present(url)) return null;
  try {
    return new URL(url).host;
  } catch {
    return null;
  }
};

/**
 * The decisions key: CONCENTRATE_API_KEY, else the brain's gateway key in the brain's own order (ANTHROPIC_API_KEY, then
 * ANTHROPIC_AUTH_TOKEN), but only when the brain's gateway (ANTHROPIC_BASE_URL) is the decisions host. A key meant for
 * another host is never sent.
 */
export const decisionsKey = (secrets: Secrets, baseUrl: string): string | null => {
  if (present(secrets.CONCENTRATE_API_KEY)) return secrets.CONCENTRATE_API_KEY;
  const gateway = hostOf(secrets.ANTHROPIC_BASE_URL);
  if (gateway === null || gateway !== hostOf(baseUrl)) return null;
  return [secrets.ANTHROPIC_API_KEY, secrets.ANTHROPIC_AUTH_TOKEN].find(present) ?? null;
};

/** The shadow client when `decisions` is configured and a key is present; otherwise nothing is asked. */
export const decisionsClientOf = (config: Pick<StewardConfig, "decisions">, secrets: Secrets, redactor: Redactor): DecisionsClient | undefined => {
  if (config.decisions === undefined) return undefined;
  const apiKey = decisionsKey(secrets, config.decisions.baseUrl);
  if (apiKey === null) return undefined;
  return createDecisionsClient({ ...config.decisions, apiKey, redact: (text) => redactor.redact(text) });
};

const enabled = (deps: AskDeps): boolean => (deps.settings?.get() ?? DEFAULT_SETTINGS)["decisions.enabled"];

/**
 * Asks the models not yet recorded at `where` and records each answer. Shadow only: it never throws, and nothing reads
 * the answers back to act on them.
 */
export const askAndRecord = async (deps: AskDeps, where: Where, input: string, questions: Question[]): Promise<void> => {
  const client = deps.decisions;
  if (client === undefined) return;
  try {
    if (!enabled(deps)) return;
    const models = client.models.filter((model) => !deps.stores.decisions.has(where.jobId, where.point, where.subject, model));
    if (models.length === 0) return;
    const sent = deps.redactor.redact(input).slice(0, MAX_INPUT_CHARS);
    const inputSha256 = createHash("sha256").update(sent).digest("hex");
    for (const answer of await client.ask(sent, questions, models)) {
      deps.stores.decisions.record({ ...where, inputChars: sent.length, inputSha256, answer });
    }
  } catch (err) {
    logger.warn({ jobId: where.jobId, point: where.point, err: err instanceof Error ? err.message : String(err) }, "decisions: not recorded");
  }
};

/** The intake questions about a ticket, as the agent sees it. */
export const askIntake = (deps: AskDeps, at: { jobId: number; issueId: string }, ticketMarkdown: string): Promise<void> =>
  askAndRecord(deps, { ...at, loopId: null, round: null, point: "intake", subject: null }, ticketMarkdown, INTAKE_QUESTIONS);

/** The implement's real outcome on its intake rows, the ground truth `ready` is measured against; a failure is logged. */
export const recordIntakeOutcome = (deps: Pick<PipelineDeps, "stores">, jobId: number, outcome: string): void => {
  try {
    deps.stores.decisions.setOutcome(jobId, "intake", outcome);
  } catch (err) {
    logger.warn({ jobId, err: err instanceof Error ? err.message : String(err) }, "decisions: intake outcome not recorded");
  }
};
