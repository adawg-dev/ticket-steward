import type { TicketBundle, Tracker } from "../../src/tracker/types.js";

export const FAKE_APP_USER_ID = "steward-app-user";

/** In-memory Linear: reads tickets as the steward's app user. */
export class FakeTracker implements Tracker {
  readonly kind = "linear";
  private readonly issues = new Map<string, TicketBundle>();
  private rejected = false;
  private failingReads = 0;

  constructor(issues: TicketBundle[] = []) {
    for (const issue of issues) this.issues.set(issue.id, issue);
  }

  addIssue(issue: TicketBundle): void {
    this.issues.set(issue.id, issue);
  }

  getDescription(issueId: string): string {
    return this.issue(issueId).description;
  }

  labelsOf(issueId: string): string[] {
    return [...this.issue(issueId).labels];
  }

  failNextRead(): void {
    this.failingReads += 1;
  }

  rejectCredentials(): void {
    this.rejected = true;
  }

  credentialsRejected(): boolean {
    return this.rejected;
  }

  async appUserId(): Promise<string> {
    return FAKE_APP_USER_ID;
  }

  async resolveIssueId(idOrKey: string): Promise<{ id: string; identifier: string; teamKey: string }> {
    const byKey = [...this.issues.values()].find((issue) => issue.id === idOrKey || issue.identifier === idOrKey);
    if (byKey === undefined) throw new Error(`unknown issue ${idOrKey}`);
    return { id: byKey.id, identifier: byKey.identifier, teamKey: byKey.team.key };
  }

  async fetchTicket(issueId: string): Promise<TicketBundle> {
    if (this.failingReads > 0) {
      this.failingReads -= 1;
      throw new Error("Linear down");
    }
    return structuredClone(this.issue(issueId));
  }

  async readDescription(issueId: string): Promise<string> {
    return this.issue(issueId).description;
  }

  private issue(issueId: string): TicketBundle {
    const issue = this.issues.get(issueId);
    if (issue === undefined) throw new Error(`unknown issue ${issueId}`);
    return issue;
  }
}
