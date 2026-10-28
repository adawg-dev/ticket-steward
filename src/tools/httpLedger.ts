import { z } from "zod";
import type { PushLedger } from "../push/ledger.js";

const Sha = z.string().regex(/^[0-9a-f]{40}$/);

const PushStartSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("create"), base: Sha }),
  z.object({ kind: z.literal("fastForward"), branch: z.string().min(1), base: Sha }),
  z.object({ kind: z.literal("refused"), reason: z.string() }),
]);
const TicketSchema = z.object({ title: z.string(), closed: z.string().nullable() });
const RecordedSchema = z.object({ id: z.number().int().positive() });

const REQUEST_TIMEOUT_MS = 60_000;

/**
 * The push ledger of a run pod's tools sidecar: the dispatcher's internal run API, authenticated with the run's tools
 * token. The run is the token's; the target the sidecar passes is not sent, so it cannot name another job. An unfinished
 * push is settled by the dispatcher with its own read of the remote, so `start` does not use `remoteHead`.
 */
export const httpLedger = (p: { baseUrl: string; runId: string; token: string }): PushLedger => {
  const base = `${p.baseUrl.replace(/\/+$/, "")}/internal/runs/${encodeURIComponent(p.runId)}`;

  const call = async (method: "GET" | "POST", route: string, body?: unknown): Promise<unknown> => {
    const response = await fetch(`${base}/${route}`, {
      method,
      headers: { authorization: `Bearer ${p.token}`, ...(body === undefined ? {} : { "content-type": "application/json" }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      redirect: "error",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (response.status === 401) throw new Error("the run's push token was rejected");
    if (!response.ok) throw new Error(`the steward answered ${response.status} to ${method} ${route}`);
    const text = await response.text();
    return text === "" ? null : (JSON.parse(text) as unknown);
  };

  const parsed = async <T>(schema: z.ZodType<T>, method: "GET" | "POST", route: string, body?: unknown): Promise<T> => {
    const answer = schema.safeParse(await call(method, route, body));
    if (!answer.success) throw new Error(`the steward's answer to ${method} ${route} is not what the push expects`);
    return answer.data;
  };

  return {
    start: () => parsed(PushStartSchema, "POST", "push/start", {}),
    ticket: () => parsed(TicketSchema, "GET", "ticket"),
    record: (_target, push) => parsed(RecordedSchema, "POST", "push/record", push),
    landed: async (_target, id, sha) => {
      await call("POST", `push/${id}/landed`, { sha });
    },
    revert: async (_target, id) => {
      await call("POST", `push/${id}/revert`, {});
    },
  };
};
