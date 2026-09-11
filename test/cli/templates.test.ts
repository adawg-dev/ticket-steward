import { rm } from "node:fs/promises";
import { join } from "node:path";
import type { TemplateLister } from "../../src/cli/context.js";
import { buildProgram } from "../../src/cli/program.js";
import type { TicketBundle } from "../../src/tracker/types.js";
import { FakeTracker } from "../fakes/fakeTracker.js";
import { makeContext, tmpConfigDir, writeConfig } from "./helpers.js";

const issue: TicketBundle = {
  id: "issue-1",
  identifier: "API-1",
  url: "https://linear.app/acme/issue/API-1",
  title: "Adapter drops the last chunk",
  description: "",
  team: { id: "team-1", key: "API", name: "API" },
  state: { name: "Triage", type: "triage" },
  labels: [],
  priority: 2,
  creator: null,
  createdAt: "2026-09-11T00:00:00.000Z",
  comments: [],
  attachments: [],
  appliedTemplate: null,
  templates: [
    { name: "Bugs", description: "Bug report", body: "**Repro Steps**\n**Evidence**", requiredFields: ["Repro Steps", "Evidence"] },
    { name: "Feature", description: "Feature request", body: "**Goal**", requiredFields: ["Goal"] },
  ],
};

/** Exposes the templates the fake tracker would return with a ticket, scoped to the team that owns it. */
const fromFakeTracker = (tracker: FakeTracker, issueId: string): TemplateLister => ({
  listTemplates: async (teamKeys) => {
    const bundle = await tracker.fetchTicket(issueId);
    return bundle.templates.map((template) => ({ scope: teamKeys.join(","), template }));
  },
});

let dir: string;
let configPath: string;

beforeEach(async () => {
  vi.restoreAllMocks();
  dir = await tmpConfigDir();
  configPath = await writeConfig(dir, {
    dataDir: join(dir, "data"),
    overlayDir: join(dir, "overlay"),
    promptPath: join(dir, "prompt.md"),
    fetchUrl: "https://gitlab.example/acme/repo.git",
    port: 4100,
    serverPort: 3020,
  });
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("steward templates", () => {
  it("prints one line per template with its scope and required fields", async () => {
    const tracker = new FakeTracker([issue]);
    const { ctx, stdout } = makeContext({ factories: { tracker, templates: fromFakeTracker(tracker, "issue-1") } });
    await buildProgram(ctx).parseAsync(["node", "steward", "--config", configPath, "templates"]);

    expect(stdout()).toBe("API\tBugs\trequired: Repro Steps, Evidence\nAPI\tFeature\trequired: Goal\n");
  });
});
