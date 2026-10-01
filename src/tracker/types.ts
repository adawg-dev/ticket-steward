export type LabelAction = "triage" | "implement";

export type TriggerEvent =
  | {
      kind: "issue.created" | "issue.labeled";
      issueId: string;
      identifier: string;
      teamKey: string;
      deliveryId: string;
      description: string;
      stateType: string | null;
      /** Which configured label started this; absent when labels are not configured (every new ticket is triaged). */
      action?: LabelAction;
    }
  | { kind: "cli"; issueId: string; identifier: string; teamKey: string; action?: LabelAction }
  | {
      kind: "mr.review";
      deliveryId: string;
      projectId: number;
      projectPath: string;
      mrIid: number;
      mrUrl: string;
      headSha: string;
      linearKey: string;
      teamKey: string;
      reason: "opened" | "reviewer_added" | "push";
    };

export type ReviewTrigger = Extract<TriggerEvent, { kind: "mr.review" }>;
export type IssueTrigger = Exclude<TriggerEvent, { kind: "mr.review" }>;

export interface TicketBundle {
  id: string;
  identifier: string;
  url: string;
  title: string;
  description: string;
  team: { id: string; key: string; name: string };
  state: { name: string; type: string };
  labels: string[];
  priority: number;
  creator: { name: string; isBot: boolean } | null;
  createdAt: string;
  comments: Array<{ author: string; body: string; createdAt: string }>;
  attachments: Array<{ title: string; url: string }>;
  appliedTemplate: string | null;
  templates: Array<{ name: string; description: string; body: string; requiredFields: string[] }>;
}

export interface Tracker {
  kind: "linear";
  resolveIssueId(idOrKey: string): Promise<{ id: string; identifier: string; teamKey: string }>;
  fetchTicket(issueId: string): Promise<TicketBundle>;
  readDescription(issueId: string): Promise<string>;
  writeDescription(issueId: string, description: string): Promise<void>;
  postComment(issueId: string, body: string): Promise<void>;
  /** Adds `to` (if missing), then removes `from` (if present); names match case-insensitively. */
  swapLabel(issueId: string, from: string, to: string): Promise<void>;
  uploadFile(localPath: string, contentType: string): Promise<{ url: string }>;
  /** True once the tracker rejected its credentials (Linear answered 401); the worker stops claiming jobs until a restart. */
  apiKeyRejected(): boolean;
}
