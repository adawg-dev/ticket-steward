import { basename } from "node:path";
import type { TicketBundle, Tracker } from "../../src/tracker/types.js";

export type SessionActivity = { type: "thought" | "response" | "error"; body: string };
export type RecordedUpload = { path: string; contentType: string };

export class FakeTracker implements Tracker {
  readonly kind = "linear";
  readonly agentSession: Tracker["agentSession"];
  private readonly issues = new Map<string, TicketBundle>();
  private readonly issueComments = new Map<string, string[]>();
  private readonly activities = new Map<string, SessionActivity[]>();
  private readonly uploaded: RecordedUpload[] = [];
  private failingWrites = 0;

  constructor(issues: TicketBundle[] = []) {
    for (const issue of issues) this.issues.set(issue.id, issue);
    this.agentSession = {
      thought: async (sessionId, body) => this.recordActivity(sessionId, { type: "thought", body }),
      response: async (sessionId, body) => this.recordActivity(sessionId, { type: "response", body }),
      error: async (sessionId, body) => this.recordActivity(sessionId, { type: "error", body }),
    };
  }

  addIssue(issue: TicketBundle): void {
    this.issues.set(issue.id, issue);
  }

  getDescription(issueId: string): string {
    return this.issue(issueId).description;
  }

  setDescription(issueId: string, description: string): void {
    this.issues.set(issueId, { ...this.issue(issueId), description });
  }

  comments(issueId: string): string[] {
    return [...(this.issueComments.get(issueId) ?? [])];
  }

  sessionActivities(sessionId: string): SessionActivity[] {
    return [...(this.activities.get(sessionId) ?? [])];
  }

  uploads(): RecordedUpload[] {
    return [...this.uploaded];
  }

  failNextWrite(): void {
    this.failingWrites += 1;
  }

  async resolveIssueId(idOrKey: string): Promise<{ id: string; identifier: string; teamKey: string }> {
    const byKey = [...this.issues.values()].find((issue) => issue.id === idOrKey || issue.identifier === idOrKey);
    if (byKey === undefined) throw new Error(`unknown issue ${idOrKey}`);
    return { id: byKey.id, identifier: byKey.identifier, teamKey: byKey.team.key };
  }

  async fetchTicket(issueId: string): Promise<TicketBundle> {
    return structuredClone(this.issue(issueId));
  }

  async readDescription(issueId: string): Promise<string> {
    return this.issue(issueId).description;
  }

  async writeDescription(issueId: string, description: string): Promise<void> {
    this.write();
    this.setDescription(issueId, description);
  }

  async postComment(issueId: string, body: string): Promise<void> {
    this.write();
    this.issue(issueId);
    this.issueComments.set(issueId, [...(this.issueComments.get(issueId) ?? []), body]);
  }

  async uploadFile(localPath: string, contentType: string): Promise<{ url: string }> {
    this.write();
    this.uploaded.push({ path: localPath, contentType });
    return { url: `https://uploads.fake/${basename(localPath)}` };
  }

  private recordActivity(sessionId: string, activity: SessionActivity): void {
    this.write();
    this.activities.set(sessionId, [...(this.activities.get(sessionId) ?? []), activity]);
  }

  private write(): void {
    if (this.failingWrites === 0) return;
    this.failingWrites -= 1;
    throw new Error("fake tracker write failure");
  }

  private issue(issueId: string): TicketBundle {
    const issue = this.issues.get(issueId);
    if (issue === undefined) throw new Error(`unknown issue ${issueId}`);
    return issue;
  }
}
