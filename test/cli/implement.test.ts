import { rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { buildProgram } from "../../src/cli/program.js";
import type { ImplementResult } from "../../src/implement/result.js";
import type { TicketBundle } from "../../src/tracker/types.js";
import { FakeBrain } from "../fakes/fakeBrain.js";
import { FakeCodeHost } from "../fakes/fakeCodeHost.js";
import { FakeTracker } from "../fakes/fakeTracker.js";
import { freeTcpPort, tmpRepo, type TmpRepo } from "../fakes/tmpRepo.js";
import { commitFile, git } from "../workspace/helpers.js";
import { makeContext, tmpConfigDir, writeConfig } from "./helpers.js";

const IMPLEMENT_PROMPT = fileURLToPath(new URL("../../prompts/implement.md", import.meta.url));

const issue: TicketBundle = {
  id: "issue-1",
  identifier: "API-1",
  url: "https://linear.app/acme/issue/API-1",
  title: "Adapter drops the last chunk",
  description: "The adapter loses the final chunk.",
  team: { id: "team-1", key: "API", name: "API" },
  state: { name: "Todo", type: "unstarted" },
  labels: ["ready-for-agent"],
  priority: 2,
  creator: { name: "Ada", isBot: false },
  createdAt: "2026-09-11T00:00:00.000Z",
  comments: [],
  attachments: [],
  appliedTemplate: null,
  templates: [],
};

const implemented: ImplementResult = {
  outcome: "implemented",
  branchType: "fix",
  commitMessage: "Keep the last chunk\n\nFlush the buffer before closing.",
  summary: "Flush the buffer before closing the stream.",
  reviewNotes: ["Check the streaming test."],
  checksRun: ["tsc: ok"],
  questions: [],
  failureDetail: null,
};

let dir: string;
let repo: TmpRepo;
let configPath: string;
let tracker: FakeTracker;
let port: number;
let serverPort: number;

beforeEach(async () => {
  vi.restoreAllMocks();
  dir = await tmpConfigDir();
  repo = await tmpRepo("unused");
  await commitFile(repo.repo, ".gitignore", ".env\n");
  await repo.mirror.fetch();
  tracker = new FakeTracker([issue]);
  port = await freeTcpPort();
  serverPort = await freeTcpPort();
  configPath = await writeConfig(dir, {
    dataDir: repo.dataDir,
    overlayDir: repo.overlayDir,
    fetchUrl: repo.repo,
    port,
    serverPort,
    implement: { prompt: IMPLEMENT_PROMPT },
  });
});

afterEach(async () => {
  await repo.cleanup();
  await rm(dir, { recursive: true, force: true });
});

describe("steward implement", () => {
  it("dry run prints the branch and commit message and writes nothing", async () => {
    const brain = new FakeBrain({ result: implemented, editWorkspace: { "src/adapter.ts": "export const adapter = 2;\n" } });
    const { ctx, stdout } = makeContext({ factories: { tracker, codehost: new FakeCodeHost(), brain } });

    await buildProgram(ctx).parseAsync(["node", "steward", "--config", configPath, "implement", "API-1", "--dry-run"]);

    expect(stdout()).toContain("would commit on fix/API-1-adapter-drops-the-last-chunk");
    expect(stdout()).toContain("API-1: Keep the last chunk");
    expect(tracker.labelSwaps()).toEqual([]);
    expect(await git(repo.repo, ["branch", "--list", "*/API-1-*"])).toBe("");
  });

});
