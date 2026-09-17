import { rm } from "node:fs/promises";
import { join } from "node:path";
import { buildProgram } from "../../src/cli/program.js";
import type { TicketBundle } from "../../src/tracker/types.js";
import { FakeTracker } from "../fakes/fakeTracker.js";
import { tmpRepo, type TmpRepo } from "../fakes/tmpRepo.js";
import { makeContext, tmpConfigDir, writeConfig } from "./helpers.js";

const PROMPT_TEMPLATE = "Team {{teamName}} ({{teamKey}}) at {{workspacePath}}@{{sha}} port {{stewardPort}} artifacts {{artifactsDir}}\n{{ticket}}\nOperator: [{{operatorInstructions}}]\n";

const issue: TicketBundle = {
  id: "issue-1",
  identifier: "API-1",
  url: "https://linear.app/acme/issue/API-1",
  title: "Adapter drops the last chunk",
  description: "The adapter loses the final chunk.",
  team: { id: "team-1", key: "API", name: "Platform API" },
  state: { name: "Triage", type: "triage" },
  labels: ["bug"],
  priority: 2,
  creator: { name: "Ada", isBot: false },
  createdAt: "2026-09-11T00:00:00.000Z",
  comments: [],
  attachments: [],
  appliedTemplate: null,
  templates: [],
};

let dir: string;
let repo: TmpRepo;
let configPath: string;

beforeEach(async () => {
  vi.restoreAllMocks();
  dir = await tmpConfigDir();
  repo = await tmpRepo(PROMPT_TEMPLATE);
  configPath = await writeConfig(dir, {
    dataDir: repo.dataDir,
    overlayDir: repo.overlayDir,
    promptPath: repo.promptPath,
    fetchUrl: repo.repo,
    port: 4100,
    serverPort: 3020,
  });
});

afterEach(async () => {
  await repo.cleanup();
  await rm(dir, { recursive: true, force: true });
});

describe("steward prompt", () => {
  it("show prints the template verbatim", async () => {
    const { ctx, stdout } = makeContext();
    await buildProgram(ctx).parseAsync(["node", "steward", "--config", configPath, "prompt", "show"]);

    expect(stdout()).toBe(PROMPT_TEMPLATE);
  });

  it("render prints the prompt with ticket, sha and placeholders filled in", async () => {
    const { ctx, stdout } = makeContext({ factories: { tracker: new FakeTracker([issue]) } });
    await buildProgram(ctx).parseAsync(["node", "steward", "--config", configPath, "prompt", "render", "API-1"]);

    const lines = stdout().split("\n");
    expect(lines[0]).toBe(`Team Platform API (API) at <worktree>@${repo.sha} port 4100 artifacts ${join(repo.dataDir, "jobs", "<jobId>", "artifacts")}`);
    expect(stdout()).toContain("Adapter drops the last chunk");
    expect(lines.at(-2)).toBe("Operator: []");
  });
});
