import { createHmac } from "node:crypto";
import { fromOwnProject, parseGitlabEvent, verifyGitlabWebhook } from "../../src/codehost/gitlabWebhook.js";

const project = { id: 42, path_with_namespace: "acme/repo" };

describe("parseGitlabEvent", () => {
  it("reads a merge request event's branch, iid and project", () => {
    const body = { object_kind: "merge_request", project, object_attributes: { iid: 7, source_branch: "fix/API-1-keep", action: "open" } };
    expect(parseGitlabEvent("Merge Request Hook", body)).toEqual({
      kind: "merge_request", projectId: 42, projectPath: "acme/repo", branch: "fix/API-1-keep", mrIid: 7, sourceProjectId: null,
    });
  });

  it("reads a merge request note, created or edited", () => {
    const note = (action: string) => ({
      object_kind: "note", project,
      object_attributes: { noteable_type: "MergeRequest", action },
      merge_request: { iid: 7, source_branch: "fix/API-1-keep" },
    });
    const expected = { kind: "note", projectId: 42, projectPath: "acme/repo", branch: "fix/API-1-keep", mrIid: 7, sourceProjectId: null };
    expect(parseGitlabEvent("Note Hook", note("create"))).toEqual(expected);
    expect(parseGitlabEvent("Note Hook", note("update"))).toEqual(expected);
  });

  it("exposes a note's id, author, body and discussion when the payload carries them", () => {
    const body = {
      object_kind: "note", project,
      user: { id: 5, username: "ada" },
      object_attributes: { id: 901, noteable_type: "MergeRequest", action: "create", note: "/agent why?", author_id: 5, discussion_id: "abc123", system: false },
      merge_request: { iid: 7, source_branch: "fix/API-1-keep" },
    };
    expect(parseGitlabEvent("Note Hook", body)).toEqual({
      kind: "note", projectId: 42, projectPath: "acme/repo", branch: "fix/API-1-keep", mrIid: 7, sourceProjectId: null,
      note: { id: 901, authorId: 5, authorUsername: "ada", authorIsBot: false, body: "/agent why?", discussionId: "abc123", system: false },
    });
    const bot = { ...body, user: { id: 6, username: "someone", bot: true }, object_attributes: { ...body.object_attributes, discussion_id: undefined, system: true } };
    expect(parseGitlabEvent("Note Hook", bot)).toMatchObject({ note: { authorIsBot: true, discussionId: null, system: true } });
  });

  it("ignores notes on anything but a merge request", () => {
    const body = { object_kind: "note", project, object_attributes: { noteable_type: "Issue", action: "create" }, issue: { iid: 3 } };
    expect(parseGitlabEvent("Note Hook", body)).toBeNull();
  });

  it("reads a pipeline's branch, and its MR when it has one", () => {
    const branchPipeline = { object_kind: "pipeline", project, object_attributes: { ref: "fix/API-1-keep", status: "success" }, merge_request: null };
    expect(parseGitlabEvent("Pipeline Hook", branchPipeline)).toEqual({
      kind: "pipeline", projectId: 42, projectPath: "acme/repo", branch: "fix/API-1-keep", mrIid: null, sourceProjectId: null,
    });
    const mrPipeline = {
      object_kind: "pipeline", project,
      object_attributes: { ref: "refs/merge-requests/7/head", status: "running" },
      merge_request: { iid: 7, source_branch: "fix/API-1-keep" },
    };
    expect(parseGitlabEvent("Pipeline Hook", mrPipeline)).toEqual({
      kind: "pipeline", projectId: 42, projectPath: "acme/repo", branch: "fix/API-1-keep", mrIid: 7, sourceProjectId: null,
    });
  });

  it("reads the MR's source project, so a fork's MR is told apart from the project's own", () => {
    const mr = { object_kind: "merge_request", project, object_attributes: { iid: 7, source_branch: "fix/API-1-keep", source_project_id: 99 } };
    const fork = parseGitlabEvent("Merge Request Hook", mr);
    expect(fork).toMatchObject({ sourceProjectId: 99 });
    expect(fork === null ? null : fromOwnProject(fork)).toBe(false);
    const note = {
      object_kind: "note", project, object_attributes: { noteable_type: "MergeRequest" },
      merge_request: { iid: 7, source_branch: "fix/API-1-keep", source_project_id: 42 },
    };
    const own = parseGitlabEvent("Note Hook", note);
    expect(own).toMatchObject({ sourceProjectId: 42 });
    expect(own === null ? null : fromOwnProject(own)).toBe(true);
  });

  it("returns null for other events and malformed bodies", () => {
    expect(parseGitlabEvent("Push Hook", { object_kind: "push", project })).toBeNull();
    expect(parseGitlabEvent(undefined, {})).toBeNull();
    expect(parseGitlabEvent("Merge Request Hook", { object_kind: "merge_request" })).toBeNull();
    expect(parseGitlabEvent("Pipeline Hook", "not an object")).toBeNull();
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
