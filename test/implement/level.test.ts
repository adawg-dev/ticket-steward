import { chooseLevel, higher, levelRank } from "../../src/implement/level.js";

describe("chooseLevel", () => {
  it("goes to design when the ticket carries the design label, ignoring case", () => {
    expect(chooseLevel({ labels: ["Design"], designLabel: "design", defaultLevel: "small", carried: null })).toBe("design");
  });

  it("ignores the label when no design label is configured", () => {
    expect(chooseLevel({ labels: ["Design"], designLabel: undefined, defaultLevel: "small", carried: null })).toBe("small");
  });

  it("keeps a higher carried level over the default", () => {
    expect(chooseLevel({ labels: [], designLabel: "design", defaultLevel: "small", carried: "standard" })).toBe("standard");
  });

  it("keeps a carried design level without the label", () => {
    expect(chooseLevel({ labels: [], designLabel: "design", defaultLevel: "small", carried: "design" })).toBe("design");
  });

  it("falls back to the default level", () => {
    expect(chooseLevel({ labels: ["bug"], designLabel: "design", defaultLevel: "small", carried: null })).toBe("small");
  });
});

describe("levelRank and higher", () => {
  it("orders small, standard, design", () => {
    expect([levelRank("small"), levelRank("standard"), levelRank("design")]).toEqual([0, 1, 2]);
    expect(higher("small", "standard")).toBe("standard");
    expect(higher("design", "standard")).toBe("design");
  });
});
