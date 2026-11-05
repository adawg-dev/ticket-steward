import { z } from "zod";
import { logger } from "../log.js";

/**
 * Concentrate's `/v1/decisions`: typed questions answered with probabilities. The steward asks them in shadow mode only,
 * so the client never throws and never retries: a missed answer costs one unrecorded row, nothing more.
 */

export type Question =
  | { type: "predicate"; name: string; instructions: string }
  | { type: "choice"; name: string; instructions: string; choices: { value: string; description: string }[] };

/** One model's answer to one request. */
export interface ModelAnswer {
  /** The versioned model the response names (an alias such as `jev-latest` resolved), else the requested one. */
  model: string;
  requested: string;
  /** The response's `answers`, verbatim; null when there is none to record. */
  answers: unknown[] | null;
  latencyMs: number;
  cost: number | null;
  /** Why `answers` is null: "timeout", "http <status>", "refusal", "invalid response", or the network error. */
  error: string | null;
}

export interface DecisionsClient {
  /** The configured models, in order. */
  readonly models: string[];
  /** One answer per model asked (all configured, or the given subset), in that order; never rejects. */
  ask(input: string, questions: Question[], models?: string[]): Promise<ModelAnswer[]>;
}

/** What is sent of an input: the rest is cut off. */
export const MAX_INPUT_CHARS = 100_000;
const DEFAULT_TIMEOUT_MS = 10_000;

const ResponseSchema = z.object({
  model: z.string(),
  answers: z.array(z.looseObject({ type: z.string(), name: z.string().optional() })),
  cost: z.looseObject({ total: z.number().optional() }).optional(),
});

/** Runs `fn` over `items` with at most `limit` in flight, results in input order. */
export const mapLimit = async <T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> => {
  const results: R[] = new Array<R>(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const index = next;
      next += 1;
      const item = items[index] as T;
      results[index] = await fn(item);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
};

export const createDecisionsClient = (opts: {
  baseUrl: string;
  models: string[];
  apiKey: string;
  redact: (text: string) => string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  now?: () => number;
}): DecisionsClient => {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const now = opts.now ?? Date.now;
  const url = `${opts.baseUrl.replace(/\/$/, "")}/decisions`;

  const askOne = async (requested: string, input: string, questions: Question[]): Promise<ModelAnswer> => {
    const started = now();
    const failed = (error: string): ModelAnswer => {
      logger.warn({ model: requested, error }, "decisions: no answer recorded");
      return { model: requested, requested, answers: null, latencyMs: now() - started, cost: null, error };
    };
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    try {
      const response = await fetchImpl(url, {
        method: "POST",
        headers: { authorization: `Bearer ${opts.apiKey}`, "content-type": "application/json" },
        body: JSON.stringify({ model: requested, input, questions }),
        signal: controller.signal,
      });
      if (!response.ok) return failed(`http ${response.status}`);
      const parsed = ResponseSchema.safeParse(await response.json());
      if (!parsed.success) return failed("invalid response");
      if (parsed.data.answers.some((answer) => answer.type === "refusal")) return failed("refusal");
      // Every asked question must be answered by name: a partial answer would read as a prediction it is not.
      const named = new Set(parsed.data.answers.map((answer) => answer.name));
      if (questions.some((question) => !named.has(question.name))) return failed("invalid response");
      return { model: parsed.data.model, requested, answers: parsed.data.answers, latencyMs: now() - started, cost: parsed.data.cost?.total ?? null, error: null };
    } catch (err) {
      if (controller.signal.aborted) return failed("timeout");
      return failed(err instanceof Error ? err.message : String(err));
    } finally {
      clearTimeout(timer);
    }
  };

  return {
    models: opts.models,
    ask: async (input, questions, models = opts.models) => {
      const sent = opts.redact(input).slice(0, MAX_INPUT_CHARS);
      return Promise.all(models.map((model) => askOne(model, sent, questions)));
    },
  };
};
