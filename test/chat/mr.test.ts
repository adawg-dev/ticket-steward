import type { StewardConfig } from "../../src/config/schema.js";
import { DEFAULT_SETTINGS } from "../../src/settings/schema.js";
import { mrChatOf, mrChatRefusal, mrChatsEnabled, mrIssueId, ticketKeyOf } from "../../src/chat/mr.js";
import { fakeMergeRequest } from "../fakes/fakeGitLabMr.js";

const chat = (anyMergeRequest: boolean): Pick<StewardConfig, "chat"> => ({ chat: { prefix: "/agent", sessionRetentionDays: 180, anyMergeRequest } });

describe("mrChatsEnabled", () => {
  it("needs the config to allow MR chats; the setting can only switch them off", () => {
    expect(mrChatsEnabled(chat(true), DEFAULT_SETTINGS)).toBe(true);
    expect(mrChatsEnabled(chat(true), { ...DEFAULT_SETTINGS, "chat.anyMergeRequest": false })).toBe(false);
    expect(mrChatsEnabled(chat(false), DEFAULT_SETTINGS)).toBe(false);
    expect(mrChatsEnabled({ chat: undefined }, DEFAULT_SETTINGS)).toBe(false);
  });
});

describe("mrIssueId and mrChatOf", () => {
  it("round-trips the project and MR, and is null for a Linear issue id", () => {
    expect(mrIssueId(42, 7)).toBe("mr:42!7");
    expect(mrChatOf("mr:42!7")).toEqual({ projectId: 42, mrIid: 7 });
    expect(mrChatOf("3f0e2b0c-1d2e-4f5a-8b9c-0d1e2f3a4b5c")).toBeNull();
    expect(mrChatOf("mr:x!7")).toBeNull();
  });
});

describe("ticketKeyOf", () => {
  const teams = ["API", "USRAPP"];
  it("finds a configured team's key in the branch, in any case, else in the title", () => {
    expect(ticketKeyOf({ sourceBranch: "fix/usrapp-176-stale-lists", title: "Stale lists" }, teams)).toBe("USRAPP-176");
    expect(ticketKeyOf({ sourceBranch: "adam/cleanup", title: "API-412: bodyless PUT" }, teams)).toBe("API-412");
  });
  it("ignores keys of teams the steward does not serve, and look-alikes", () => {
    expect(ticketKeyOf({ sourceBranch: "fix/ops-9-thing", title: "UTF-8 names" }, teams)).toBeNull();
    expect(ticketKeyOf({ sourceBranch: "adam/cleanup", title: "Tidy" }, teams)).toBeNull();
  });
});

describe("mrChatRefusal", () => {
  const base = { baseBranch: "dev" };
  it("allows an open MR from the project's own non-protected branch, drafts included", async () => {
    expect(mrChatRefusal(fakeMergeRequest({ sourceBranch: "adam/fix" }), { ...base, protectedSource: false })).toBeNull();
    expect(mrChatRefusal(fakeMergeRequest({ sourceBranch: "adam/fix", draft: true }), { ...base, protectedSource: false })).toBeNull();
  });
  it("refuses a closed or merged MR, a fork's MR, the base branch and a protected branch, saying why", () => {
    expect(mrChatRefusal(fakeMergeRequest({ state: "merged" }), { ...base, protectedSource: false })).toMatch(/merged/);
    expect(mrChatRefusal(fakeMergeRequest({ state: "closed" }), { ...base, protectedSource: false })).toMatch(/closed/);
    expect(mrChatRefusal(fakeMergeRequest({ sourceProjectId: 99 }), { ...base, protectedSource: false })).toMatch(/fork/);
    expect(mrChatRefusal(fakeMergeRequest({ sourceBranch: "dev" }), { ...base, protectedSource: false })).toMatch(/dev/);
    expect(mrChatRefusal(fakeMergeRequest({ sourceBranch: "staging" }), { ...base, protectedSource: true })).toMatch(/protected/);
  });
});
