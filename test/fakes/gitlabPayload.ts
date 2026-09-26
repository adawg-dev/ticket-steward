export const BOT = "steward-bot";
export const HEAD = "c".repeat(40);

export const mrPayload = (overrides: { action?: string; oldrev?: string | null; state?: string; reviewers?: string[]; changes?: unknown; source_branch?: string; title?: string; description?: string; source_project_id?: number } = {}) => ({
  object_kind: "merge_request",
  event_type: "merge_request",
  project: { id: 42, path_with_namespace: "acme/repo" },
  object_attributes: {
    iid: 7,
    action: overrides.action ?? "update",
    state: overrides.state ?? "opened",
    title: overrides.title ?? "Fix final chunk",
    description: overrides.description ?? "",
    source_branch: overrides.source_branch ?? "api-123-fix-stream",
    target_branch: "main",
    source_project_id: overrides.source_project_id ?? 42,
    target_project_id: 42,
    url: "https://gitlab.example/acme/repo/-/merge_requests/7",
    oldrev: overrides.oldrev ?? null,
    last_commit: { id: HEAD },
  },
  reviewers: (overrides.reviewers ?? [BOT]).map((username) => ({ id: 1, username, name: username })),
  changes: overrides.changes ?? {},
});
