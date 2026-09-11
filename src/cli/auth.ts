import type { Command } from "commander";
import { buildServer } from "../server/app.js";
import { openStores, type Stores, type TokenPair } from "../store/index.js";
import { buildAuthorizeUrl, createLinearTracker } from "../tracker/linear/index.js";
import { fail, loadFromProgram, println, type CliContext } from "./context.js";
import { answers, localHealthUrl, sleep } from "./probe.js";

const STATE_TTL_MS = 10 * 60 * 1000;
const CALLBACK_TIMEOUT_MS = 10 * 60 * 1000;
const HEALTH_TIMEOUT_MS = 2_000;
const POLL_MS = 1_000;
const CALLBACK_PATH = "/oauth/linear/callback";

const isNewPair = (pair: TokenPair | null, before: TokenPair | null): pair is TokenPair =>
  pair !== null && pair.accessToken !== before?.accessToken;

const waitForNewPair = async (stores: Stores, before: TokenPair | null): Promise<TokenPair | null> => {
  const deadline = Date.now() + CALLBACK_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const pair = stores.tokens.get();
    if (isNewPair(pair, before)) return pair;
    await sleep(POLL_MS);
  }
  return null;
};

export const registerAuth = (program: Command, ctx: CliContext): void => {
  const auth = program.command("auth").description("authorize the steward against a tracker");

  auth
    .command("linear")
    .description("actor=app OAuth flow; waits for the callback on serve or a temporary listener")
    .action(async () => {
      const loaded = await loadFromProgram(program, ctx);
      const { config, secrets } = loaded;
      const { LINEAR_CLIENT_ID: clientId, LINEAR_CLIENT_SECRET: clientSecret } = secrets;
      if (clientId === undefined || clientSecret === undefined) return fail(ctx, "LINEAR_CLIENT_ID and LINEAR_CLIENT_SECRET must be set in .env");
      const stores = openStores(config.dataDir);
      const before = stores.tokens.get();
      const state = stores.tokens.createOauthState(STATE_TTL_MS);
      println(ctx, "Open this URL as a Linear workspace admin:");
      println(ctx, buildAuthorizeUrl({ clientId, redirectUri: `${config.server.publicUrl}${CALLBACK_PATH}`, state }));

      const serveUp = await answers(ctx.fetchImpl, localHealthUrl(config.server.port), HEALTH_TIMEOUT_MS);
      const app = serveUp
        ? null
        : buildServer({ config, secrets, stores, tracker: createLinearTracker(stores, secrets), workerState: () => ({ running: null }), fetchImpl: ctx.fetchImpl });
      if (app === null) println(ctx, "steward serve is running and will receive the callback; finish the authorization in the browser");
      else {
        await app.listen({ port: config.server.port });
        println(ctx, `waiting for the callback on port ${config.server.port}`);
      }
      try {
        const pair = await waitForNewPair(stores, before);
        if (pair === null) return fail(ctx, "timed out waiting for the Linear callback");
        println(ctx, `Linear authorized; app user ${pair.appUserId ?? "unknown"}`);
      } finally {
        await app?.close();
      }
    });
};
