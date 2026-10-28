import { alreadyCommented, truncate } from "../../src/core/render.js";

describe("truncate", () => {
  it("returns short strings unchanged", () => {
    expect(truncate("abc", 3)).toBe("abc");
  });

  it("cuts long strings to max length ending in an ellipsis", () => {
    expect(truncate("abcdef", 4)).toBe("abc…");
  });
});

describe("alreadyCommented", () => {
  it("matches a comment by its first line only", () => {
    expect(alreadyCommented([{ body: "Implemented (job 7)\nold body" }], "Implemented (job 7)\nnew body")).toBe(true);
    expect(alreadyCommented([{ body: "Implemented (job 6)" }], "Implemented (job 7)")).toBe(false);
    expect(alreadyCommented([{ body: "" }], "")).toBe(false);
  });
});
