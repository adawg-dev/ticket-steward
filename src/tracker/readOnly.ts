import type { TicketBundle, Tracker } from "./types.js";

export interface RecordedWrite {
  method: "writeDescription" | "postComment" | "uploadFile" | "swapLabel";
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

  async writeDescription(issueId: string, description: string): Promise<void> {
    this.record("writeDescription", [issueId, description]);
  }

  async postComment(issueId: string, body: string): Promise<void> {
    this.record("postComment", [issueId, body]);
  }

  async swapLabel(issueId: string, from: string, to: string): Promise<void> {
    this.record("swapLabel", [issueId, from, to]);
  }

  async uploadFile(localPath: string, contentType: string): Promise<{ url: string }> {
    this.record("uploadFile", [localPath, contentType]);
    return { url: `file://${localPath}` };
  }

  apiKeyRejected(): boolean {
    return this.inner.apiKeyRejected();
  }

  private record(method: RecordedWrite["method"], args: string[]): void {
    this.writes.push({ method, args });
  }
}
