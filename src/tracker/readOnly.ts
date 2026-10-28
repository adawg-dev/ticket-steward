import type { TicketBundle, Tracker } from "./types.js";

export interface RecordedWrite {
  method: "swapLabel";
  args: string[];
}

export class ReadOnlyTracker implements Tracker {
  readonly kind = "linear";
  readonly writes: RecordedWrite[] = [];

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

  async swapLabel(issueId: string, from: string, to: string): Promise<void> {
    this.record("swapLabel", [issueId, from, to]);
  }

  apiKeyRejected(): boolean {
    return this.inner.apiKeyRejected();
  }

  private record(method: RecordedWrite["method"], args: string[]): void {
    this.writes.push({ method, args });
  }
}
