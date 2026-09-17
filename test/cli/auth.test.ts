import { rm } from "node:fs/promises";
import { join } from "node:path";
import { buildProgram } from "../../src/cli/program.js";
import { openStores } from "../../src/store/index.js";
import { freeTcpPort } from "../fakes/tmpRepo.js";
import { writeFile } from "node:fs/promises";
import { makeContext, tmpConfigDir, waitFor, writeConfig } from "./helpers.js";

let dir: string;
let dataDir: string;
let configPath: string;
let serverPort: number;

const linearFetch: typeof fetch = async (input) => {
  const url = String(input);
  if (url === "https://api.linear.app/oauth/token") {
    return new Response(JSON.stringify({ access_token: "lin_oauth_access1234", refresh_token: "refresh-1", expires_in: 86400 }), { status: 200 });
  }
  if (url === "https://api.linear.app/graphql") return new Response(JSON.stringify({ data: { viewer: { id: "user-1" } } }), { status: 200 });
  throw new Error("Intended Test Error");
};

beforeEach(async () => {
  vi.restoreAllMocks();
  dir = await tmpConfigDir();
  dataDir = join(dir, "data");
  serverPort = await freeTcpPort();
  await writeFile(join(dir, ".env"), "LINEAR_CLIENT_ID=client-id\nLINEAR_CLIENT_SECRET=client-secret\n");
  configPath = await writeConfig(dir, {
    dataDir,
    overlayDir: join(dir, "overlay"),
    promptPath: join(dir, "prompt.md"),
    fetchUrl: "https://gitlab.example/acme/repo.git",
    port: 4100,
    serverPort,
  });
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("steward auth linear", () => {
  it("prints the authorize URL, receives the callback on a temporary listener and stores the token pair", async () => {
    const { ctx, stdout } = makeContext({ fetchImpl: linearFetch });
    const done = buildProgram(ctx).parseAsync(["node", "steward", "--config", configPath, "auth", "linear"]);
    await waitFor(() => stdout().includes("waiting for the callback"));

    const authorizeUrl = new URL(stdout().split("\n")[1] ?? "");
    expect(authorizeUrl.origin + authorizeUrl.pathname).toBe("https://linear.app/oauth/authorize");
    expect(authorizeUrl.searchParams.get("actor")).toBe("app");
    expect(authorizeUrl.searchParams.get("redirect_uri")).toBe("https://steward.example/oauth/linear/callback");
    const state = authorizeUrl.searchParams.get("state") ?? "";

    const callback = await fetch(`http://localhost:${serverPort}/oauth/linear/callback?code=auth-code&state=${state}`);
    expect(callback.status).toBe(200);
    await done;

    expect(stdout().endsWith("Linear authorized; app user user-1\n")).toBe(true);
    expect(openStores(dataDir).tokens.get()?.appUserId).toBe("user-1");
    expect(openStores(dataDir).tokens.get()?.accessToken).toBe("lin_oauth_access1234");
  });
});
