import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TriggerEvent } from "../../src/tracker/types.js";

export const freshDataDir = (): string => mkdtempSync(join(tmpdir(), "steward-store-"));

export const createdEvent: TriggerEvent = {
  kind: "linear",
  run: "implement",
  issueId: "issue-1",
  identifier: "API-1",
  teamKey: "API",
  sessionId: "session-1",
  message: null,
};

export const secondEvent: TriggerEvent = {
  kind: "linear",
  run: "implement",
  issueId: "issue-2",
  identifier: "API-2",
  teamKey: "API",
  sessionId: "session-2",
  message: null,
};
