import { isBugTicket, normalizeRepro } from "../../src/core/repro.js";
import type { BrainResult } from "../../src/core/result.js";

const result: BrainResult = {
  template: { matched: null, conforms: true, missing: [] },
  summary: "s",
  enrichment: "e",
  attachments: [],
  confidence: "high",
  repro: { status: "reproduced", method: "http", command: "curl -s localhost:4100/v1/x", steps: [], files: [], expected: "200", observed: "500" },
};

describe("isBugTicket", () => {
  it("matches a configured label ignoring case and whitespace", () => {
    expect(isBugTicket(["bug "], ["Bug"])).toBe(true);
    expect(isBugTicket(["Feature", "Defect"], ["Bug", "defect"])).toBe(true);
  });

  it("is false without a matching label", () => {
    expect(isBugTicket(["Feature"], ["Bug"])).toBe(false);
    expect(isBugTicket([], ["Bug"])).toBe(false);
  });
});

describe("normalizeRepro", () => {
  it("keeps the recipe for bugs", () => {
    expect(normalizeRepro(result, true).repro).toEqual(result.repro);
  });

  it("drops any recipe for non-bugs", () => {
    expect(normalizeRepro(result, false).repro).toBeNull();
  });
});
