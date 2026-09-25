import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TriggerEvent } from "../../src/tracker/types.js";
import type { BrainResult } from "../../src/core/result.js";

export const freshDataDir = (): string => mkdtempSync(join(tmpdir(), "steward-store-"));

export const createdEvent: TriggerEvent = {
  kind: "issue.created",
  issueId: "issue-1",
  identifier: "API-1",
  teamKey: "API",
  deliveryId: "delivery-1",
  description: "A bug report",
};

export const secondEvent: TriggerEvent = {
  kind: "issue.created",
  issueId: "issue-2",
  identifier: "API-2",
  teamKey: "API",
  deliveryId: "delivery-2",
  description: "Another bug report",
};

export const brainResult: BrainResult = {
  template: { matched: "Bugs", conforms: false, missing: ["Repro Steps"] },
  summary: "The bug is in the adapter.",
  enrichment: "See `src/adapter.ts:12`.",
  attachments: [],
  confidence: "high",
};
