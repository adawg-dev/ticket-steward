import type { Secrets } from "../../config/load.js";
import { LinearTracker } from "./client.js";

export { createLinearClient, LinearApiKeyRejectedError, LinearTracker } from "./client.js";
export { toTemplateSummary } from "./templates.js";
export { parseEvent, verifySignature } from "./webhook.js";

export const requireLinearApiKey = (secrets: Secrets): string => {
  const apiKey = secrets.LINEAR_API_KEY;
  if (apiKey === undefined || apiKey === "") throw new Error("LINEAR_API_KEY must be set in .env");
  return apiKey;
};

export const createLinearTracker = (secrets: Secrets): LinearTracker => new LinearTracker(requireLinearApiKey(secrets));
