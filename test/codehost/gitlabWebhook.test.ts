import { createHmac } from "node:crypto";
import { extractLinearKey, parseMergeRequestEvent, verifyGitlabWebhook } from "../../src/codehost/gitlabWebhook.js";
import { BOT, HEAD, mrPayload } from "../fakes/gitlabPayload.js";

const opts = { deliveryId: "gitlab:w-1", botUsername: BOT, teams: ["API", "RSPNS"], allowForks: false };

const parsed = (body: unknown): string | null => {
  const result = parseMergeRequestEvent(body, opts);
  return result.ok ? null : result.reason;
};

describe("extractLinearKey", () => {
  it("finds a lower-case key in a branch and upper-cases it", () => {
    expect(extractLinearKey(["api-123-fix-stream"], ["API"])).toEqual({ key: "API-123", teamKey: "API" });
  });

  it("skips keys of teams outside the allowlist", () => {
    expect(extractLinearKey(["Handle UTF-8 in RSPNS-9"], ["API", "RSPNS"])).toEqual({ key: "RSPNS-9", teamKey: "RSPNS" });
  });

  it("searches the texts in order", () => {
    expect(extractLinearKey(["feature/cleanup", "[API-4] Fix", "Closes API-5"], ["API"])).toEqual({ key: "API-4", teamKey: "API" });
  });

  it("accepts any team when the allowlist is empty, and returns null when nothing matches", () => {
    expect(extractLinearKey(["ops-12"], [])).toEqual({ key: "OPS-12", teamKey: "OPS" });
    expect(extractLinearKey(["no key here", "v2"], ["API"])).toBeNull();
  });
});

describe("parseMergeRequestEvent", () => {
  it("queues a review when the steward is newly added as a reviewer (object shape)", () => {
    const parsed = parseMergeRequestEvent(mrPayload({ changes: { reviewers: { previous: [], current: [{ username: BOT }] } } }), opts);
    expect(parsed).toEqual({
      ok: true,
      trigger: {
        kind: "mr.review",
        deliveryId: "gitlab:w-1",
        projectId: 42,
        projectPath: "acme/repo",
        mrIid: 7,
        mrUrl: "https://gitlab.example/acme/repo/-/merge_requests/7",
        headSha: HEAD,
        linearKey: "API-123",
        teamKey: "API",
        reason: "reviewer_added",
      },
    });
  });

  it("accepts the [previous, current] array shape of changes.reviewers", () => {
    const parsed = parseMergeRequestEvent(mrPayload({ changes: { reviewers: [[{ username: "ana" }], [{ username: "ana" }, { username: BOT }]] } }), opts);
    expect(parsed.ok && parsed.trigger.reason).toBe("reviewer_added");
  });

  it("queues a review on a push while the steward is a reviewer", () => {
    const parsed = parseMergeRequestEvent(mrPayload({ oldrev: "b".repeat(40) }), opts);
    expect(parsed.ok && parsed.trigger.reason).toBe("push");
  });

  it("queues a review when an MR opens with the steward already a reviewer", () => {
    const parsed = parseMergeRequestEvent(mrPayload({ action: "open" }), opts);
    expect(parsed.ok && parsed.trigger.reason).toBe("opened");
  });

  it("ignores everything else with a reason", () => {
    expect(parsed(mrPayload({ reviewers: ["ana"], oldrev: "b".repeat(40) }))).toBe("the steward is not a reviewer");
    expect(parsed(mrPayload({ state: "merged", oldrev: "b".repeat(40) }))).toBe("merge request is merged");
    expect(parsed(mrPayload({ action: "approved" }))).toBe("no review-relevant change (action approved)");
    expect(parsed(mrPayload({}))).toBe("no review-relevant change (action update)");
    expect(parsed(mrPayload({ oldrev: "b".repeat(40), source_project_id: 99 }))).toBe("merge request comes from a fork");
    expect(parsed(mrPayload({ oldrev: "b".repeat(40), source_branch: "cleanup", title: "Tidy", description: "" }))).toBe("no Linear key in the branch, title or description");
    expect(parsed({ object_kind: "push" })).toBe("not a merge request event");
  });

  it("allows forks when configured", () => {
    expect(parseMergeRequestEvent(mrPayload({ oldrev: "b".repeat(40), source_project_id: 99 }), { ...opts, allowForks: true }).ok).toBe(true);
  });

  it("derives a delivery id when GitLab sent none", () => {
    const result = parseMergeRequestEvent(mrPayload({ oldrev: "b".repeat(40) }), { ...opts, deliveryId: undefined });
    expect(result.ok && result.trigger.deliveryId).toBe(`gitlab:42:7:${HEAD}:push`);
  });
});

describe("verifyGitlabWebhook", () => {
  const raw = '{"object_kind":"merge_request"}';
  const key = Buffer.from("0123456789abcdef0123456789abcdef");
  const signingToken = `whsec_${key.toString("base64")}`;
  const now = 1_790_000_000;
  const signature = (id: string, ts: number, body: string): string => `v1,${createHmac("sha256", key).update(`${id}.${ts}.${body}`).digest("base64")}`;
  const none = { token: undefined, id: undefined, timestamp: undefined, signature: undefined };

  it("accepts the secret token", () => {
    expect(verifyGitlabWebhook(raw, { ...none, token: "s3cret-token" }, { secret: "s3cret-token", signingToken: undefined }, now)).toBe(true);
    expect(verifyGitlabWebhook(raw, { ...none, token: "wrong" }, { secret: "s3cret-token", signingToken: undefined }, now)).toBe(false);
  });

  it("accepts a valid signature among several", () => {
    const headers = { ...none, id: "msg_1", timestamp: String(now), signature: `v1,bogus ${signature("msg_1", now, raw)}` };
    expect(verifyGitlabWebhook(raw, headers, { secret: undefined, signingToken }, now)).toBe(true);
  });

  it("rejects a tampered body, a stale timestamp and missing credentials", () => {
    const headers = { ...none, id: "msg_1", timestamp: String(now), signature: signature("msg_1", now, raw) };
    expect(verifyGitlabWebhook(`${raw} `, headers, { secret: undefined, signingToken }, now)).toBe(false);
    expect(verifyGitlabWebhook(raw, headers, { secret: undefined, signingToken }, now + 301)).toBe(false);
    expect(verifyGitlabWebhook(raw, none, { secret: undefined, signingToken: undefined }, now)).toBe(false);
  });
});
