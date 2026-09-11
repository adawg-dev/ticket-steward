import { evaluateTool } from "../../src/brain/policy.js";

const workspacePath = "/data/work/42-1";
const artifactsDir = "/data/jobs/42/artifacts";
const denyPaths = ["/data/repo.git", "/data/steward.db", "/data/overlay"];
const evaluate = (name: string, input: unknown) => evaluateTool({ name, input, workspacePath, artifactsDir, denyPaths });

describe("evaluateTool", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("denies git push", () => {
    expect(evaluate("Bash", { command: "git push origin HEAD" }).allow).toBe(false);
  });

  it("denies git push with extra whitespace", () => {
    expect(evaluate("Bash", { command: "git  push" }).allow).toBe(false);
  });

  it("allows git pull", () => {
    expect(evaluate("Bash", { command: "git pull" })).toEqual({ allow: true });
  });

  it("denies Write outside the worktree", () => {
    expect(evaluate("Write", { file_path: "/tmp/elsewhere.txt", content: "x" }).allow).toBe(false);
  });

  it("allows Write into the artifacts directory", () => {
    expect(evaluate("Write", { file_path: `${artifactsDir}/shot.png`, content: "x" })).toEqual({ allow: true });
  });

  it("allows Write to a relative path inside the worktree", () => {
    expect(evaluate("Write", { file_path: "src/notes.md", content: "x" })).toEqual({ allow: true });
  });

  it("denies Bash referencing a denied path", () => {
    expect(evaluate("Bash", { command: "cat /data/overlay/.env" }).allow).toBe(false);
  });

  it("denies run_shell whose args reference a denied path", () => {
    expect(evaluate("run_shell", { command: "ls", args: ["/data/repo.git"] }).allow).toBe(false);
  });

  it("denies MCP tools outside codehost and playwright", () => {
    expect(evaluate("mcp__slack__send", { text: "hi" }).allow).toBe(false);
  });

  it("allows the codehost MCP tools", () => {
    expect(evaluate("mcp__codehost__recent_changes", { paths: ["src"] })).toEqual({ allow: true });
  });

  it("allows read-only tools", () => {
    expect(evaluate("Read", { file_path: "/data/overlay/.env" })).toEqual({ allow: true });
  });
});
