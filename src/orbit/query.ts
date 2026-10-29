import { z } from "zod";
import { logger } from "../log.js";
import { runOrbitTool, type OrbitRemote } from "./server.js";

/** One read-only openCypher query against the remote Orbit API, answered as Orbit's raw JSON. Throws when it fails. */
export type OrbitQuery = (cypher: string) => Promise<unknown>;

/** What the dispatcher asks first: any answer at all means the remote API works for the steward's token. */
export const ORBIT_PROBE_QUERY = "MATCH (j:Job) WHERE j.id = 0 RETURN count(j) AS n";

/** Runs a query through the same runner as the agents' orbit_query tool: token in the child's env only, masked output. */
const runQuery = (remote: OrbitRemote): OrbitQuery => async (cypher) => {
  const result = await runOrbitTool(remote, ["query", "--response-format", "raw", "--", cypher]);
  const text = result.content[0]?.text ?? "";
  if (result.isError === true) throw new Error(text);
  return JSON.parse(text);
};

/**
 * The remote query, once a probe shows it works; null when it does not (no token, no Orbit, a 403 for the steward's
 * token), logged once. Never throws: CI triage then goes on without Orbit's signals.
 */
export const probeOrbitQuery = async (remote: OrbitRemote): Promise<OrbitQuery | null> => {
  const query = runQuery(remote);
  try {
    await query(ORBIT_PROBE_QUERY);
    return query;
  } catch (err) {
    logger.warn({ err: err instanceof Error ? err.message : String(err) }, "orbit: the remote query API does not answer; CI triage goes on without it");
    return null;
  }
};

/** The probe on first use, then its answer for good: the dispatcher's Orbit for CI triage. */
export const lazyOrbitQuery = (remote: OrbitRemote): (() => Promise<OrbitQuery | null>) => {
  let probed: Promise<OrbitQuery | null> | undefined;
  return () => (probed ??= probeOrbitQuery(remote));
};

const CountSchema = z.object({ result: z.object({ rows: z.array(z.object({ n: z.number() })).min(1) }) });

/** The `n` of a `RETURN count(...) AS n` query's raw answer; null when the answer has no such row. */
export const orbitCount = (answer: unknown): number | null => {
  const parsed = CountSchema.safeParse(answer);
  return parsed.success ? (parsed.data.result.rows[0]?.n ?? null) : null;
};
