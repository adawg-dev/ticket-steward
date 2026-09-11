import type { Secrets } from "../../config/load.js";
import type { Stores } from "../../store/index.js";
import { LinearAuth } from "./auth.js";
import { LinearTracker } from "./client.js";

export { LinearAuth, LINEAR_SCOPES, buildAuthorizeUrl, exchangeCode, type TokenRepository } from "./auth.js";
export { LinearTracker } from "./client.js";
export { toTemplateSummary } from "./templates.js";
export { parseEvent, verifySignature } from "./webhook.js";

export const createLinearTracker = (stores: Pick<Stores, "tokens">, secrets: Secrets): LinearTracker => {
  const { LINEAR_CLIENT_ID: clientId, LINEAR_CLIENT_SECRET: clientSecret } = secrets;
  if (clientId === undefined || clientSecret === undefined) {
    throw new Error("LINEAR_CLIENT_ID and LINEAR_CLIENT_SECRET must be set in .env");
  }
  return new LinearTracker(new LinearAuth(stores.tokens, { clientId, clientSecret }));
};
