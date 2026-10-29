import { createLinearAgentApi, LINEAR_GRAPHQL_URL } from "../../../src/tracker/linear/agent.js";
import { LinearCredentialsRejectedError, type LinearToken } from "../../../src/tracker/linear/auth.js";

interface GraphqlCall {
  operation: string;
  query: string;
  variables: Record<string, unknown>;
  authorization: string;
}

const json = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const OPERATION = /^\s*(?:query|mutation)\s+(\w+)/;

/** A fake Linear GraphQL endpoint: answers each operation from `answers` and records what was sent. */
const fakeGraphql = (answers: Record<string, (variables: Record<string, unknown>) => Response>) => {
  const calls: GraphqlCall[] = [];
  const fetchImpl = vi.fn<typeof fetch>(async (input, init) => {
    expect(String(input)).toBe(LINEAR_GRAPHQL_URL);
    expect(init?.method).toBe("POST");
    const headers = new Headers(init?.headers);
    const body = JSON.parse(String(init?.body)) as { query: string; variables: Record<string, unknown> };
    const operation = OPERATION.exec(body.query)?.[1] ?? "unknown";
    calls.push({ operation, query: body.query, variables: body.variables, authorization: headers.get("authorization") ?? "" });
    const answer = answers[operation];
    if (answer === undefined) throw new Error(`unexpected operation ${operation}`);
    return answer(body.variables);
  });
  return { fetchImpl, calls, operations: () => calls.map((call) => call.operation) };
};

/** A token that hands out numbered tokens, re-minting after the current one is invalidated. */
const fakeToken = (): LinearToken & { mints: () => number } => {
  let minted = 1;
  let current: string | null = "token-1";
  return {
    get: async () => {
      if (current === null) current = `token-${++minted}`;
      return current;
    },
    invalidate: (rejected) => {
      if (rejected === current) current = null;
    },
    revoke: async () => undefined,
    mints: () => minted,
  };
};

const ok = (field: string) => () => json({ data: { [field]: { success: true } } });

const TEAM_STATES = [
  { id: "s-backlog", name: "Backlog", type: "backlog", position: 0 },
  { id: "s-todo", name: "Todo", type: "unstarted", position: 1 },
  { id: "s-review", name: "In Review", type: "started", position: 3 },
  { id: "s-progress", name: "In Progress", type: "started", position: 2 },
  { id: "s-done", name: "Done", type: "completed", position: 4 },
];

const issueWithState = (state: { id: string; name: string; type: string }) => () =>
  json({ data: { issue: { state, team: { states: { nodes: TEAM_STATES } } } } });

describe("createLinearAgentApi", () => {
  it("creates an activity with the session, content and ephemeral flag, authorised by the app token", async () => {
    const linear = fakeGraphql({ AgentActivityCreate: ok("agentActivityCreate") });
    const api = createLinearAgentApi(fakeToken(), linear.fetchImpl);

    await api.createActivity("session-1", { type: "action", action: "Editing", parameter: "src/x.ts" }, { ephemeral: true });
    await api.createActivity("session-1", { type: "action", action: "Running", parameter: "npm test", result: "ok" });
    await api.createActivity("session-1", { type: "response", body: "Done." });

    expect(linear.calls.map((call) => call.variables)).toEqual([
      { input: { agentSessionId: "session-1", content: { type: "action", action: "Editing", parameter: "src/x.ts" }, ephemeral: true } },
      { input: { agentSessionId: "session-1", content: { type: "action", action: "Running", parameter: "npm test", result: "ok" }, ephemeral: false } },
      { input: { agentSessionId: "session-1", content: { type: "response", body: "Done." }, ephemeral: false } },
    ]);
    expect(linear.calls[0]?.query).toContain("agentActivityCreate(input: $input)");
    expect(linear.calls.every((call) => call.authorization === "Bearer token-1")).toBe(true);
  });

  it("allows ephemeral thoughts", async () => {
    const linear = fakeGraphql({ AgentActivityCreate: ok("agentActivityCreate") });
    const api = createLinearAgentApi(fakeToken(), linear.fetchImpl);

    await api.createActivity("session-1", { type: "thought", body: "Reading the ticket" }, { ephemeral: true });

    expect(linear.calls[0]?.variables).toEqual({
      input: { agentSessionId: "session-1", content: { type: "thought", body: "Reading the ticket" }, ephemeral: true },
    });
  });

  it.each([
    { type: "response" as const, body: "Done." },
    { type: "elicitation" as const, body: "Which one?" },
    { type: "error" as const, body: "Failed." },
  ])("refuses an ephemeral $type without calling Linear", async (content) => {
    const linear = fakeGraphql({});
    const api = createLinearAgentApi(fakeToken(), linear.fetchImpl);

    await expect(api.createActivity("session-1", content, { ephemeral: true })).rejects.toThrow(`a ${content.type} activity cannot be ephemeral`);
    expect(linear.fetchImpl).not.toHaveBeenCalled();
  });

  it("replaces the session's external URLs", async () => {
    const linear = fakeGraphql({ AgentSessionUpdate: ok("agentSessionUpdate") });
    const api = createLinearAgentApi(fakeToken(), linear.fetchImpl);

    await api.setExternalUrls("session-1", [{ label: "Merge request", url: "https://gitlab.example.com/g/p/-/merge_requests/7" }]);

    expect(linear.calls[0]?.variables).toEqual({
      id: "session-1",
      input: { externalUrls: [{ label: "Merge request", url: "https://gitlab.example.com/g/p/-/merge_requests/7" }] },
    });
    expect(linear.calls[0]?.query).toContain("agentSessionUpdate(id: $id, input: $input)");
  });

  it("sets the session's plan", async () => {
    const linear = fakeGraphql({ AgentSessionUpdate: ok("agentSessionUpdate") });
    const api = createLinearAgentApi(fakeToken(), linear.fetchImpl);
    const plan = [
      { content: "Read the ticket", status: "completed" as const },
      { content: "Write the fix", status: "inProgress" as const },
      { content: "Open the MR", status: "pending" as const },
    ];

    await api.setPlan("session-1", plan);

    expect(linear.calls[0]?.variables).toEqual({ id: "session-1", input: { plan } });
  });

  it("sets and clears the issue's delegate", async () => {
    const linear = fakeGraphql({ IssueDelegate: ok("issueUpdate") });
    const api = createLinearAgentApi(fakeToken(), linear.fetchImpl);

    await api.setDelegate("issue-1", "app-user-1");
    await api.setDelegate("issue-1", null);

    expect(linear.calls.map((call) => call.variables)).toEqual([
      { id: "issue-1", input: { delegateId: "app-user-1" } },
      { id: "issue-1", input: { delegateId: null } },
    ]);
    expect(linear.calls[0]?.query).toContain("issueUpdate(id: $id, input: $input)");
  });

  it("reads the issue's state", async () => {
    const linear = fakeGraphql({ IssueState: () => json({ data: { issue: { state: { type: "started", name: "In Progress" } } } }) });
    const api = createLinearAgentApi(fakeToken(), linear.fetchImpl);

    expect(await api.issueState("issue-1")).toEqual({ type: "started", name: "In Progress" });
    expect(linear.calls[0]?.variables).toEqual({ id: "issue-1" });
  });

  it("moves an unstarted issue to the team's first started state", async () => {
    const linear = fakeGraphql({
      IssueStates: issueWithState({ id: "s-todo", name: "Todo", type: "unstarted" }),
      IssueMove: ok("issueUpdate"),
    });
    const api = createLinearAgentApi(fakeToken(), linear.fetchImpl);

    expect(await api.moveToState("issue-1", { type: "started" })).toBe("moved");

    expect(linear.operations()).toEqual(["IssueStates", "IssueMove"]);
    expect(linear.calls[0]?.variables).toEqual({ id: "issue-1" });
    expect(linear.calls[1]?.variables).toEqual({ id: "issue-1", input: { stateId: "s-progress" } });
  });

  it.each([
    { id: "s-review", name: "In Review", type: "started" },
    { id: "s-done", name: "Done", type: "completed" },
    { id: "s-gone", name: "Canceled", type: "canceled" },
  ])("leaves an issue already in $name when asked to start it", async (state) => {
    const linear = fakeGraphql({ IssueStates: issueWithState(state) });
    const api = createLinearAgentApi(fakeToken(), linear.fetchImpl);

    expect(await api.moveToState("issue-1", { type: "started" })).toBe("already");
    expect(linear.operations()).toEqual(["IssueStates"]);
  });

  it("moves an issue to a named state", async () => {
    const linear = fakeGraphql({
      IssueStates: issueWithState({ id: "s-progress", name: "In Progress", type: "started" }),
      IssueMove: ok("issueUpdate"),
    });
    const api = createLinearAgentApi(fakeToken(), linear.fetchImpl);

    expect(await api.moveToState("issue-1", { name: "In Review" })).toBe("moved");
    expect(linear.calls[1]?.variables).toEqual({ id: "issue-1", input: { stateId: "s-review" } });
  });

  it("leaves an issue already in the named state", async () => {
    const linear = fakeGraphql({ IssueStates: issueWithState({ id: "s-review", name: "In Review", type: "started" }) });
    const api = createLinearAgentApi(fakeToken(), linear.fetchImpl);

    expect(await api.moveToState("issue-1", { name: "In Review" })).toBe("already");
    expect(linear.operations()).toEqual(["IssueStates"]);
  });

  it("reports a named state the team does not have as missing", async () => {
    const linear = fakeGraphql({ IssueStates: issueWithState({ id: "s-progress", name: "In Progress", type: "started" }) });
    const api = createLinearAgentApi(fakeToken(), linear.fetchImpl);

    expect(await api.moveToState("issue-1", { name: "Code Review" })).toBe("missing");
    expect(linear.operations()).toEqual(["IssueStates"]);
  });

  it("reports a team without a started state as missing", async () => {
    const linear = fakeGraphql({
      IssueStates: () =>
        json({ data: { issue: { state: { id: "s-todo", name: "Todo", type: "unstarted" }, team: { states: { nodes: [TEAM_STATES[1]] } } } } }),
    });
    const api = createLinearAgentApi(fakeToken(), linear.fetchImpl);

    expect(await api.moveToState("issue-1", { type: "started" })).toBe("missing");
  });

  it("re-mints once after a 401 and retries with the new token", async () => {
    const token = fakeToken();
    let calls = 0;
    const linear = fakeGraphql({
      AgentActivityCreate: () => (++calls === 1 ? json({ errors: [{ message: "Authentication required" }] }, 401) : ok("agentActivityCreate")()),
    });
    const api = createLinearAgentApi(token, linear.fetchImpl);

    await api.createActivity("session-1", { type: "thought", body: "hi" });

    expect(linear.calls.map((call) => call.authorization)).toEqual(["Bearer token-1", "Bearer token-2"]);
  });

  it("treats a GraphQL AUTHENTICATION_ERROR like a 401, and a second rejection as rejected credentials", async () => {
    const token = fakeToken();
    const linear = fakeGraphql({
      AgentActivityCreate: () => json({ errors: [{ message: "Authentication required", extensions: { code: "AUTHENTICATION_ERROR" } }] }),
    });
    const api = createLinearAgentApi(token, linear.fetchImpl);

    await expect(api.createActivity("session-1", { type: "thought", body: "hi" })).rejects.toBeInstanceOf(LinearCredentialsRejectedError);
    expect(token.mints()).toBe(2);
    expect(linear.calls).toHaveLength(2);
  });

  it("fails on GraphQL errors and unsuccessful mutations, naming the operation", async () => {
    const linear = fakeGraphql({
      AgentActivityCreate: () => json({ errors: [{ message: "Entity not found", extensions: { code: "INVALID_INPUT" } }] }),
      AgentSessionUpdate: () => json({ data: { agentSessionUpdate: { success: false } } }),
      IssueState: () => json({ message: "busy" }, 503),
    });
    const api = createLinearAgentApi(fakeToken(), linear.fetchImpl);

    await expect(api.createActivity("session-1", { type: "thought", body: "hi" })).rejects.toThrow("Linear AgentActivityCreate failed: Entity not found");
    await expect(api.setPlan("session-1", [])).rejects.toThrow("Linear AgentSessionUpdate was not successful");
    await expect(api.issueState("issue-1")).rejects.toThrow("Linear IssueState answered 503");
  });
});
