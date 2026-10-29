import { errorMessage } from "../core/workspace.js";

export const CALLBACK_REQUEST_TIMEOUT_MS = 60_000;

/**
 * How long a run pod's callback (the run report, the work report) is retried: longer than a dispatcher restart (one
 * replica, Recreate), and well inside the margin the Job's deadline leaves after the run.
 */
export const REPORT_RETRY_MS = 5 * 60_000;
export const REPORT_BACKOFF_MS = { first: 1_000, max: 15_000 };

/** The dispatcher refused the callback itself (a bad token or body): another attempt would be refused as well. */
class CallbackRefusedError extends Error {}

/** Answers worth another attempt: the dispatcher restarting, overloaded or behind a proxy that has no upstream yet. */
const retryableStatus = (status: number): boolean => status >= 500 || status === 408 || status === 429;

/**
 * POSTs `body` to the dispatcher's run API with the run's `token`. Connection errors, timeouts and 5xx are retried with
 * backoff for `retryForMs` (the dispatcher may be restarting); a 401 or another 4xx fails at once. `what` names the
 * callback and `tokenName` the token in errors.
 */
export const postCallback = async (p: {
  url: string;
  token: string;
  body: string;
  what: string;
  tokenName: string;
  fetchImpl: typeof fetch;
  retryForMs?: number;
  backoffMs?: { first: number; max: number };
  warn?: (message: string) => void;
}): Promise<void> => {
  const retryForMs = p.retryForMs ?? REPORT_RETRY_MS;
  const backoff = p.backoffMs ?? REPORT_BACKOFF_MS;
  const deadline = Date.now() + retryForMs;
  let delay = backoff.first;
  for (let attempt = 1; ; attempt += 1) {
    let failure: string;
    try {
      const response = await p.fetchImpl(p.url, {
        method: "POST",
        headers: { authorization: `Bearer ${p.token}`, "content-type": "application/json" },
        body: p.body,
        redirect: "error",
        signal: AbortSignal.timeout(CALLBACK_REQUEST_TIMEOUT_MS),
      });
      if (response.ok) return;
      await response.body?.cancel();
      if (response.status === 401) throw new CallbackRefusedError(`the run's ${p.tokenName} token was rejected`);
      if (!retryableStatus(response.status)) throw new CallbackRefusedError(`the steward answered ${response.status} to the ${p.what}`);
      failure = `the steward answered ${response.status}`;
    } catch (err) {
      if (err instanceof CallbackRefusedError) throw err;
      failure = errorMessage(err);
    }
    if (Date.now() + delay > deadline) throw new Error(`the ${p.what} was not delivered in ${retryForMs / 1000} s (${attempt} attempts): ${failure}`);
    p.warn?.(`the ${p.what} was not delivered (${failure}); retrying in ${delay / 1000} s`);
    await new Promise((resolve) => setTimeout(resolve, delay));
    delay = Math.min(delay * 2, backoff.max);
  }
};
