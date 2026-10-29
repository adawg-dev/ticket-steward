import type { TicketBundle, Tracker } from "./types.js";

/** A tracker for dry runs: reads pass through; it has no writes to record (Linear writes go through the agent API). */
export class ReadOnlyTracker implements Tracker {
  readonly kind = "linear";

  constructor(private readonly inner: Tracker) {}

  resolveIssueId(idOrKey: string): Promise<{ id: string; identifier: string; teamKey: string }> {
    return this.inner.resolveIssueId(idOrKey);
  }

  fetchTicket(issueId: string): Promise<TicketBundle> {
    return this.inner.fetchTicket(issueId);
  }

  readDescription(issueId: string): Promise<string> {
    return this.inner.readDescription(issueId);
  }

  appUserId(): Promise<string> {
    return this.inner.appUserId();
  }

  credentialsRejected(): boolean {
    return this.inner.credentialsRejected();
  }
}
