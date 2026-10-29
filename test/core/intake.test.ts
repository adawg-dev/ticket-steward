import { closedReason } from "../../src/core/intake.js";

describe("closedReason", () => {
  it("names a closed state", () => {
    expect(closedReason("API-1", { name: "Done", type: "completed" })).toBe("API-1 is Done; Ticket Steward does not work on Done or Canceled tickets");
    expect(closedReason("API-1", { name: "Todo", type: "unstarted" })).toBeNull();
  });
});
