import { startPushMcpServer } from "../../src/push/server.js";

/** Answers by `branchType`: "throw" throws, "refuse" refuses, anything else pushes; overlapping calls are reported. */
let running = 0;
await startPushMcpServer({
  push: async ({ branchType, note }) => {
    running += 1;
    try {
      await new Promise((resolve) => setTimeout(resolve, 50));
      if (running > 1) return { ok: false, reason: "overlapping pushes", detail: "" };
      if (branchType === "throw") throw new Error("git exploded");
      if (branchType === "refuse") return { ok: false, reason: "commit or discard your changes first", detail: "notes.md" };
      return { ok: true, branch: `${branchType ?? "fix"}/API-1-x`, sha: "a".repeat(40), commits: note === undefined ? 1 : 2 };
    } finally {
      running -= 1;
    }
  },
});
