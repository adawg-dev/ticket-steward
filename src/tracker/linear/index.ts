import type { Secrets } from "../../config/load.js";
import { createClientCredentialsToken, LINEAR_APP_SCOPES, type LinearToken } from "./auth.js";
import { LinearTracker } from "./client.js";

export { createClientCredentialsToken, LINEAR_APP_SCOPES, LinearCredentialsRejectedError, type LinearToken } from "./auth.js";
export { createLinearClient, LinearTracker } from "./client.js";
export { listIssueTemplates } from "./templateList.js";
export { toTemplateSummary } from "./templates.js";
export { parseLinearEvent, verifySignature, type LinearEvent } from "./webhook.js";

export const requireLinearAppCredentials = (secrets: Secrets): { clientId: string; clientSecret: string } => {
  const { LINEAR_CLIENT_ID: clientId, LINEAR_CLIENT_SECRET: clientSecret } = secrets;
  if (clientId === undefined || clientId === "" || clientSecret === undefined || clientSecret === "") {
    throw new Error("LINEAR_CLIENT_ID and LINEAR_CLIENT_SECRET must be set (Secrets Manager DEV_STEWARD_LINEAR_CLIENT_ID and DEV_STEWARD_LINEAR_CLIENT_SECRET)");
  }
  return { clientId, clientSecret };
};

export interface LinearDeps {
  fetchImpl?: typeof fetch;
  now?: () => number;
}

/** The app's token, minted on first use; nothing calls Linear until then. */
export const createLinearToken = (secrets: Secrets, deps: LinearDeps = {}): LinearToken =>
  createClientCredentialsToken({
    ...requireLinearAppCredentials(secrets),
    scopes: LINEAR_APP_SCOPES,
    fetchImpl: deps.fetchImpl ?? fetch,
    now: deps.now ?? Date.now,
  });

export const createLinearTracker = (secrets: Secrets, deps: LinearDeps & { token?: LinearToken } = {}): LinearTracker =>
  new LinearTracker(deps.token ?? createLinearToken(secrets, deps));
