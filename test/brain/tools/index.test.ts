import { capHead, capTail } from "../../../src/brain/tools/index.js";

describe("output caps", () => {
  const long = Array.from({ length: 5_000 }, (_, i) => `line ${i}`).join("\n");

  it("keeps the start of a long file and says how to read the rest", () => {
    const capped = capHead(long, 1_000);

    expect(capped.startsWith("line 0\n")).toBe(true);
    expect(capped).toMatch(/\[truncated: showing 1000 of \d+ chars; use offset\/limit to read more\]$/);
    expect(capped.length).toBeLessThan(1_100);
  });

  it("keeps the end of long command output, where errors usually are", () => {
    const capped = capTail(long, 1_000);

    expect(capped.startsWith("[truncated: showing the last 1000 of")).toBe(true);
    expect(capped.endsWith("line 4999")).toBe(true);
  });

  it("leaves short text alone", () => {
    expect(capHead("short", 1_000)).toBe("short");
    expect(capTail("short", 1_000)).toBe("short");
  });
});
