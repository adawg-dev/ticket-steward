import type { TicketBundle, Tracker } from "../../src/tracker/types.js";

/** In-memory Linear: reads tickets and records label swaps, the steward's only Linear writes. */
export class FakeTracker implements Tracker {
  readonly kind = "linear";
  private readonly issues = new Map<string, TicketBundle>();
  private readonly swaps: Array<{ issueId: string; from: string; to: string }> = [];
  private failingSwaps = 0;
  private rejected = false;

  constructor(issues: TicketBundle[] = []) {
    for (const issue of issues) this.issues.set(issue.id, issue);
  }

  addIssue(issue: TicketBundle): void {
    this.issues.set(issue.id, issue);
  }

  getDescription(issueId: string): string {
    return this.issue(issueId).description;
  }

  labelSwaps(): Array<{ issueId: string; from: string; to: string }> {
    return [...this.swaps];
  }

  labelsOf(issueId: string): string[] {
    return [...this.issue(issueId).labels];
  }

  failNextSwap(): void {
    this.failingSwaps += 1;
  }

  rejectApiKey(): void {
    this.rejected = true;
  }

  apiKeyRejected(): boolean {
    return this.rejected;
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

  async swapLabel(issueId: string, from: string, to: string): Promise<void> {
    if (this.failingSwaps > 0) {
      this.failingSwaps -= 1;
      throw new Error("Linear down");
    }
    const current = this.issue(issueId);
    const kept = current.labels.filter((label) => label.toLowerCase() !== from.toLowerCase());
    const labels = kept.some((label) => label.toLowerCase() === to.toLowerCase()) ? kept : [...kept, to];
    this.issues.set(issueId, { ...current, labels });
    this.swaps.push({ issueId, from, to });
  }

  private issue(issueId: string): TicketBundle {
    const issue = this.issues.get(issueId);
    if (issue === undefined) throw new Error(`unknown issue ${issueId}`);
    return issue;
  }
}
