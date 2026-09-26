import { Redactor } from "../../src/core/redact.js";
import { parseMarker, postUnverifiable, publishReview, reviewMarker, type ReviewPublishInput } from "../../src/review/publish.js";
import type { ReviewComment, StoredReview } from "../../src/review/result.js";
import type { ReviewTrigger } from "../../src/tracker/types.js";
import { BOT, FakeGitLabReview } from "../fakes/fakeGitLabReview.js";
import { FakeTracker } from "../fakes/fakeTracker.js";

const HEAD = "c".repeat(40);
const BASE = "a".repeat(40);
const DIFF = ["diff --git a/src/adapter.ts b/src/adapter.ts", "--- a/src/adapter.ts", "+++ b/src/adapter.ts", "@@ -1,2 +1,3 @@", " const a = 1;", "-const b = 2;", "+const b = 3;", "+const c = 4;", ""].join("\n");

const trigger: ReviewTrigger = {
  kind: "mr.review", deliveryId: "d", projectId: 42, projectPath: "acme/repo", mrIid: 7,
  mrUrl: "https://gitlab.example/acme/repo/-/merge_requests/7", headSha: HEAD, linearKey: "API-1", teamKey: "API", reason: "push",
};

const comment = (overrides: Partial<ReviewComment> = {}): ReviewComment => ({ path: "src/adapter.ts", line: 2, side: "new", severity: "major", body: "Off by one.", ...overrides });

const stored = (overrides: Partial<StoredReview["result"]> = {}): StoredReview => ({
  result: { verdict: "fixed", rerun: { observed: "final chunk arrives", deviations: null }, summary: "Looks right.", comments: [comment()], confidence: "high", ...overrides },
  diffRefs: { baseSha: BASE, startSha: BASE, headSha: HEAD },
});

const input = (review: StoredReview, jobId = 9): ReviewPublishInput => ({ jobId, trigger, issueId: "issue-1", identifier: "API-1", stored: review, diff: DIFF, botUsername: BOT, maxComments: 15 });

let api: FakeGitLabReview;
let tracker: FakeTracker;
const deps = () => ({ api, tracker, redactor: new Redactor(["sk-live-secret-value"]), permalink: (path: string, sha: string, line?: number) => `https://gl/${sha}/${path}#L${line ?? 0}` });

beforeEach(() => {
  api = new FakeGitLabReview();
  tracker = new FakeTracker([
    {
      id: "issue-1", identifier: "API-1", url: "u", title: "t", description: "", team: { id: "t", key: "API", name: "API" },
      state: { name: "s", type: "started" }, labels: ["Bug"], priority: 0, creator: null, createdAt: "", comments: [], attachments: [], appliedTemplate: null, templates: [],
    },
  ]);
});

describe("markers", () => {
  it("round-trips", () => {
    expect(parseMarker(`text\n\n${reviewMarker(9, HEAD, "c0")}`)).toEqual({ jobId: 9, sha: HEAD, key: "c0" });
    expect(parseMarker("no marker")).toBeNull();
  });
});

describe("publishReview", () => {
  it("posts an inline discussion at the right position and a summary", async () => {
    expect(await publishReview(input(stored()), deps())).toEqual({ status: "succeeded" });
    expect(api.positions).toHaveLength(1);
    expect(api.positions[0]?.position).toEqual({ baseSha: BASE, startSha: BASE, headSha: HEAD, oldPath: "src/adapter.ts", newPath: "src/adapter.ts", oldLine: null, newLine: 2 });
    expect(api.positions[0]?.body).toContain("**Major:** Off by one.");
    expect(api.positions[0]?.body).toContain(reviewMarker(9, HEAD, "c0"));
    expect(api.notes).toHaveLength(1);
    expect(api.notes[0]).toContain("**Verdict: fixed.**");
    expect(api.notes[0]).toContain(reviewMarker(9, HEAD, "summary"));
  });

  it("moves unanchorable comments to the summary", async () => {
    await publishReview(input(stored({ comments: [comment({ line: 40 })] })), deps());
    expect(api.positions).toHaveLength(0);
    expect(api.notes[0]).toContain("**Other findings**");
    expect(api.notes[0]).toContain("[src/adapter.ts:40](https://gl/" + HEAD + "/src/adapter.ts#L40)");
  });

  it("falls back to the summary on a 400", async () => {
    api.rejected.add("src/adapter.ts:2");
    expect((await publishReview(input(stored()), deps())).status).toBe("succeeded");
    expect(api.positions).toHaveLength(0);
    expect(api.notes[0]).toContain("Off by one.");
  });

  it("caps inline comments at maxComments, most severe first", async () => {
    const review = stored({ comments: [comment({ severity: "minor", body: "nit" }), comment({ line: 3, severity: "blocker", body: "crash" })] });
    await publishReview({ ...input(review), maxComments: 1 }, deps());
    expect(api.positions.map((p) => p.position.newLine)).toEqual([3]);
    expect(api.notes[0]).toContain("nit");
  });

  it("retries without duplicating posted comments", async () => {
    const review = stored({ comments: [comment(), comment({ line: 3, body: "second" })] });
    api.failCreateAfter(1);
    expect((await publishReview(input(review), deps())).status).toBe("publish_failed");
    expect(api.positions).toHaveLength(1);
    expect(await publishReview(input(review), deps())).toEqual({ status: "succeeded" });
    expect(api.positions).toHaveLength(2);
    expect(api.notes).toHaveLength(1);
  });

  it("resolves the steward's open threads from earlier jobs only", async () => {
    const stale = api.addDiscussion(BOT, `old\n\n${reviewMarker(3, "b".repeat(40), "c0")}`);
    const human = api.addDiscussion("ana", "please rename");
    const done = api.addDiscussion(BOT, `older\n\n${reviewMarker(2, "b".repeat(40), "c0")}`, { resolved: true });
    await publishReview(input(stored()), deps());
    expect(api.resolved).toEqual([stale]);
    expect(api.replies).toEqual([{ discussionId: stale, body: `Superseded by the steward's review of \`${HEAD.slice(0, 7)}\` (job 9).` }]);
    expect(api.resolved).not.toContain(human);
    expect(api.resolved).not.toContain(done);
  });

  it("comments on Linear only when the fix is verified", async () => {
    await publishReview(input(stored()), deps());
    expect(tracker.comments("issue-1")).toHaveLength(1);
    expect(tracker.comments("issue-1")[0]).toContain("Verified fixed by !7");
    api = new FakeGitLabReview();
    await publishReview(input(stored({ verdict: "not_fixed" }), 10), deps());
    expect(tracker.comments("issue-1")).toHaveLength(1);
  });

  it("redacts secrets in everything it posts", async () => {
    await publishReview(input(stored({ summary: "leaked sk-live-secret-value", comments: [comment({ body: "token sk-live-secret-value" })] })), deps());
    expect(api.notes[0]).not.toContain("sk-live-secret-value");
    expect(api.positions[0]?.body).not.toContain("sk-live-secret-value");
  });
});

describe("postUnverifiable", () => {
  it("posts one note per merge request", async () => {
    const args = { jobId: 9, trigger, identifier: "API-1", botUsername: BOT, reason: "No reproduction was recorded." };
    await postUnverifiable(api, args, new Redactor([]));
    await postUnverifiable(api, { ...args, jobId: 10 }, new Redactor([]));
    expect(api.notes).toHaveLength(1);
    expect(api.notes[0]).toContain("could not reproduce API-1");
  });
});
