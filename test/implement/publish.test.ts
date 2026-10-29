import type { RunContext } from "../../src/core/types.js";
import { buildImplementSummary, publishImplement } from "../../src/implement/publish.js";
import type { ImplementResult, StoredImplement } from "../../src/implement/result.js";
import type { TicketBundle, TriggerEvent } from "../../src/tracker/types.js";
import { FakeTracker } from "../fakes/fakeTracker.js";

const issue: TicketBundle = {
  id: "issue-1",
  identifier: "API-1",
  url: "https://linear.app/acme/issue/API-1",
  title: "Adapter drops the last chunk",
  description: "The adapter loses the final chunk.",
  team: { id: "team-1", key: "API", name: "API" },
  state: { name: "In Progress", type: "started" },
  labels: ["ready-for-agent"],
  priority: 2,
  creator: { name: "Ada", isBot: false },
  createdAt: "2026-10-27T00:00:00.000Z",
  comments: [],
  attachments: [],
  appliedTemplate: null,
  templates: [],
};

const implemented: ImplementResult = {
  outcome: "implemented",
  summary: "Flush the buffer before closing the stream.",
  reviewNotes: ["Check the streaming test.", " "],
  checksRun: ["tsc: ok"],
  questions: [],
  failureDetail: null,
  media: [],
};

const labeled: TriggerEvent = { kind: "issue.labeled", issueId: "issue-1", identifier: "API-1", teamKey: "API", deliveryId: "d-1", description: "", stateType: "started", action: "implement" };

const ctxFor = (trigger: TriggerEvent): RunContext => ({ jobId: 3, attempt: 1, issueId: "issue-1", identifier: "API-1", teamKey: "API", trigger, dryRun: false });

let tracker: FakeTracker;

beforeEach(() => {
  tracker = new FakeTracker([structuredClone(issue)]);
});

const publish = (stored: StoredImplement, trigger: TriggerEvent = labeled) =>
  publishImplement({ ctx: ctxFor(trigger), tracker, stored });

describe("publishImplement", () => {
  it("succeeds after a push and moves no labels", async () => {
    expect(await publish({ result: implemented, handback: null })).toEqual({ status: "succeeded" });
    expect(tracker.labelsOf("issue-1")).toEqual(["ready-for-agent"]);
  });

  it("succeeds with the hand-back's reason as a warning", async () => {
    const stored: StoredImplement = { result: { ...implemented, outcome: "needs_info", questions: ["Which stream?"] }, handback: { label: "needsInfo", reason: "the ticket needs more information", detail: "" } };
    expect(await publish(stored)).toEqual({ status: "succeeded", warning: "handed back: the ticket needs more information" });
  });

  it("fails a job whose ticket was closed meanwhile", async () => {
    tracker.addIssue({ ...structuredClone(issue), state: { name: "Done", type: "completed" } });
    expect(await publish({ result: implemented, handback: null })).toEqual({ status: "failed", error: "API-1 is Done; Ticket Steward does not work on Done or Canceled tickets", retryable: false });
  });

  it("reports a failed ticket read as publish_failed so a retry runs it again", async () => {
    tracker.failNextRead();
    expect(await publish({ result: implemented, handback: null })).toEqual({ status: "publish_failed", error: "ticket: Linear down" });
  });
});

describe("buildImplementSummary", () => {
  it("lists the summary, the reviewer notes and the checks the agent ran", () => {
    expect(buildImplementSummary({ jobId: 3, identifier: "API-1", result: implemented })).toBe(
      [
        "Ticket Steward implemented API-1 (job 3).",
        "",
        "Flush the buffer before closing the stream.",
        "",
        "**For the reviewer**",
        "- Check the streaming test.",
        "",
        "**Checks the agent ran**",
        "- tsc: ok",
      ].join("\n"),
    );
  });

  it("ends with the screenshots and videos the job attached, and what it could not attach", () => {
    const media = { embeds: [{ caption: "After", markdown: "![a.png](/uploads/1/a.png)" }], rejected: [{ name: "x.exe", reason: "not an image or video" }] };
    expect(buildImplementSummary({ jobId: 3, identifier: "API-1", result: { ...implemented, reviewNotes: [], checksRun: [] }, media })).toBe(
      [
        "Ticket Steward implemented API-1 (job 3).",
        "",
        "Flush the buffer before closing the stream.",
        "",
        "**Screenshots and recordings**",
        "",
        "After",
        "",
        "![a.png](/uploads/1/a.png)",
        "",
        "Not attached: `x.exe` (not an image or video)",
      ].join("\n"),
    );
  });

  it("leaves out empty sections", () => {
    expect(buildImplementSummary({ jobId: 3, identifier: "API-1", result: { ...implemented, reviewNotes: [], checksRun: [] } })).toBe(
      "Ticket Steward implemented API-1 (job 3).\n\nFlush the buffer before closing the stream.",
    );
  });
});
