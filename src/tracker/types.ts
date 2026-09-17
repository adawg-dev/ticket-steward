export type TriggerEvent =
  | { kind: "issue.created"; issueId: string; identifier: string; teamKey: string; deliveryId: string; description: string }
  | {
      kind: "agent.session";
      action: "created" | "prompted";
      issueId: string;
      identifier: string;
      teamKey: string;
      sessionId: string;
      deliveryId: string;
      promptBody?: string;
    }
  | { kind: "cli"; issueId: string; identifier: string; teamKey: string };

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

export interface AgentSessionPort {
  thought(sessionId: string, body: string): Promise<void>;
  response(sessionId: string, body: string): Promise<void>;
  error(sessionId: string, body: string): Promise<void>;
}

export interface Tracker {
  kind: "linear";
  resolveIssueId(idOrKey: string): Promise<{ id: string; identifier: string; teamKey: string }>;
  fetchTicket(issueId: string): Promise<TicketBundle>;
  readDescription(issueId: string): Promise<string>;
  writeDescription(issueId: string, description: string): Promise<void>;
  postComment(issueId: string, body: string): Promise<void>;
  uploadFile(localPath: string, contentType: string): Promise<{ url: string }>;
  agentSession: AgentSessionPort;
}
