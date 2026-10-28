import { homedir } from "node:os";
import { evaluateTool } from "../../src/brain/policy.js";

const workspacePath = "/data/work/42-1";
const artifactsDir = "/data/jobs/42/artifacts";
const denyPaths = ["/data/repo.git", "/data/steward.db", "/data/overlay"];
const evaluate = (name: string, input: unknown) => evaluateTool({ name, input, workspacePath, artifactsDir, denyPaths });

describe("evaluateTool", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("applies the shell rules to start_process", () => {
    expect(evaluate("start_process", { name: "x", command: "git", args: ["push"] }).allow).toBe(false);
    expect(evaluate("start_process", { name: "x", command: "cat", args: ["/data/overlay/.env"] }).allow).toBe(false);
    expect(evaluate("start_process", { name: "dev", command: "pnpm", args: ["--filter", "user-app", "exec", "next", "dev"] }).allow).toBe(true);
  });

  it("denies git push", () => {
    expect(evaluate("Bash", { command: "git push origin HEAD" }).allow).toBe(false);
  });

  it("denies git push with extra whitespace", () => {
    expect(evaluate("Bash", { command: "git  push" }).allow).toBe(false);
  });

  it("lets the agent stage, commit and amend its own commits", () => {
    expect(evaluate("Bash", { command: "git add -A" })).toEqual({ allow: true });
    expect(evaluate("Bash", { command: "git commit -m x" })).toEqual({ allow: true });
    expect(evaluate("Bash", { command: "git commit --amend --no-edit" })).toEqual({ allow: true });
  });

  it("keeps git push, remote, worktree, gc and update-ref denied", () => {
    for (const command of ["git push", "git remote -v", "git worktree add ../x", "git gc", "git update-ref refs/heads/x HEAD"]) {
      expect(evaluate("Bash", { command }).allow).toBe(false);
    }
  });

  it("allows the steward's push tool", () => {
    expect(evaluate("mcp__push__push", { branchType: "fix" })).toEqual({ allow: true });
  });

  it("denies git config", () => {
    expect(evaluate("Bash", { command: "git config --get remote.origin.url" }).allow).toBe(false);
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

  it("denies Bash reaching a denied path through a relative path", () => {
    expect(evaluate("Bash", { command: `cp ../../steward.db ${artifactsDir}/db.txt` }).allow).toBe(false);
  });

  it("denies Bash reaching a denied path through a quoted relative path after an operator", () => {
    expect(evaluate("Bash", { command: "ls && cat '../../repo.git/config'" }).allow).toBe(false);
  });

  it("denies Bash paths that start with an unresolvable shell variable and climb out", () => {
    expect(evaluate("Bash", { command: "cat $OLDPWD/../steward.db" }).allow).toBe(false);
  });

  it("denies Bash paths under a home-relative prefix that resolve into a denied path", () => {
    expect(evaluateTool({ name: "Bash", input: { command: "cat ~/secret.db" }, workspacePath, artifactsDir, denyPaths: [homedir()] }).allow).toBe(false);
  });

  it("allows Bash with relative paths that stay outside the denied paths", () => {
    expect(evaluate("Bash", { command: "cat ../../work/41-1/README.md ./src/index.ts && curl http://localhost:$PORT/health" })).toEqual({ allow: true });
  });

  it("denies run_shell whose args reference a denied path", () => {
    expect(evaluate("run_shell", { command: "ls", args: ["/data/repo.git"] }).allow).toBe(false);
  });

  it("denies run_shell whose args reach a denied path relatively", () => {
    expect(evaluate("run_shell", { command: "ls", args: ["../../repo.git"] }).allow).toBe(false);
  });

  it("denies MCP tools outside codehost and playwright", () => {
    expect(evaluate("mcp__slack__send", { text: "hi" }).allow).toBe(false);
  });

  it("allows the codehost MCP tools", () => {
    expect(evaluate("mcp__codehost__recent_changes", { paths: ["src"] })).toEqual({ allow: true });
  });

  it("denies Read of a denied path", () => {
    expect(evaluate("Read", { file_path: "/data/overlay/.env" }).allow).toBe(false);
  });

  it("denies Read of a denied path through a relative path", () => {
    expect(evaluate("Read", { file_path: "../../steward.db" }).allow).toBe(false);
  });

  it("denies read_file and list_dir under a denied path", () => {
    expect(evaluate("read_file", { path: "../../repo.git/config" }).allow).toBe(false);
    expect(evaluate("list_dir", { path: "/data/overlay" }).allow).toBe(false);
  });

  it("allows reads outside the worktree that are not denied", () => {
    expect(evaluate("Read", { file_path: "/usr/lib/node_modules/react/package.json" })).toEqual({ allow: true });
    expect(evaluate("Grep", { pattern: "TODO", path: "../41-1" })).toEqual({ allow: true });
    expect(evaluate("Glob", { pattern: "**/*.ts" })).toEqual({ allow: true });
  });

  it("denies Grep scoped to a denied path", () => {
    expect(evaluate("Grep", { pattern: "token", path: "/data/repo.git" }).allow).toBe(false);
  });

  it.each([
    { name: "Bash", input: { command: "sudo -n /usr/local/sbin/steward-slot down 2" } },
    { name: "Bash", input: { command: "pnpm test && sudo true" } },
    { name: "Bash", input: { command: "echo $(sudo id)" } },
    { name: "Bash", input: { command: "/usr/bin/sudo -n /usr/local/sbin/steward-slot up 1" } },
    { name: "Bash", input: { command: "docker ps" } },
    { name: "Bash", input: { command: "docker compose -p steward-slot-2 down" } },
    { name: "Bash", input: { command: "docker-compose up -d" } },
    { name: "run_shell", input: { command: "sudo -n /usr/local/sbin/steward-slot down 1" } },
    { name: "run_shell", input: { command: "docker compose ls" } },
    { name: "start_process", input: { name: "x", command: "docker", args: ["compose", "up"] } },
    { name: "start_process", input: { name: "x", command: "sudo", args: ["-n", "/usr/local/sbin/steward-slot", "down", "2"] } },
  ])("denies $name $input.command", ({ name, input }) => {
    expect(evaluate(name, input)).toEqual({ allow: false, reason: expect.stringMatching(/^command matches denied pattern /) });
  });

  it.each(["pnpm --filter user-app exec next dev", "cat docker/Dockerfile", "grep -rn pseudo src", "ls dockerfiles"])("still allows %s", (command) => {
    expect(evaluate("Bash", { command })).toEqual({ allow: true });
  });
});
