import { RESOURCE_GUARD_DEFAULTS } from "../../src/config/schema.js";
import { holdReason } from "../../src/worker/resources.js";

const guard = RESOURCE_GUARD_DEFAULTS;
const ample = { availableMemoryMb: 16_000, loadPerCpu: 0.5 };
const longAgo = 60_000;

describe("holdReason", () => {
  it("lets a start through with ample memory, low load and no recent start", () => {
    expect(holdReason(guard, ample, longAgo)).toBeNull();
  });

  it("names short memory", () => {
    expect(holdReason(guard, { ...ample, availableMemoryMb: 2048 }, longAgo)).toEqual({ cause: "shortage", reason: "available memory 2048 MB is under 4096 MB" });
  });

  it("names a load over the ceiling", () => {
    expect(holdReason(guard, { ...ample, loadPerCpu: 1.75 }, longAgo)).toEqual({ cause: "shortage", reason: "load per CPU 1.75 is over 1.5" });
  });

  it("names a start inside the spacing window", () => {
    expect(holdReason(guard, ample, 10_000)).toEqual({ cause: "spacing", reason: "last heavy job started 10s ago, spacing is 30s" });
  });

  it("never holds when disabled", () => {
    expect(holdReason({ ...guard, enabled: false }, { availableMemoryMb: 0, loadPerCpu: 50 }, 0)).toBeNull();
  });
});
