import { describe, expect, it } from "vitest";
import { collectCiFailures } from "../../src/greptile/ci.js";
import { Redactor } from "../../src/core/redact.js";
import { FakeGitLabMr } from "../fakes/fakeGitLabMr.js";

describe("collectCiFailures", () => {
  it("returns each failed job with its trace tail", async () => {
    const gitlab = new FakeGitLabMr();
    gitlab.failed = [
      { id: 1, name: "lint", stage: "test", webUrl: "https://gl/1" },
      { id: 2, name: "unit", stage: "test", webUrl: "https://gl/2" },
    ];
    gitlab.traces.set(1, "a\nb\nc");
    gitlab.traces.set(2, "x\ny\nz");
    const out = await collectCiFailures(gitlab, 42, 9, 2, new Redactor([]));
    expect(out).toEqual([
      { name: "lint", stage: "test", webUrl: "https://gl/1", logTail: "b\nc" },
      { name: "unit", stage: "test", webUrl: "https://gl/2", logTail: "y\nz" },
    ]);
  });
  it("masks secrets in traces", async () => {
    const gitlab = new FakeGitLabMr();
    gitlab.failed = [{ id: 1, name: "lint", stage: "test", webUrl: "u" }];
    gitlab.traces.set(1, "token=supersecretvalue123 failed");
    const [failure] = await collectCiFailures(gitlab, 42, 9, 10, new Redactor(["supersecretvalue123"]));
    expect(failure?.logTail).not.toContain("supersecretvalue123");
  });
});
