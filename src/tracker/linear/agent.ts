import { z } from "zod";
import { LinearCredentialsRejectedError, type LinearToken } from "./auth.js";

export const LINEAR_GRAPHQL_URL = "https://api.linear.app/graphql";

/** An agent activity's content, as Linear's agent panel renders it. */
export type ActivityContent =
  | { type: "thought"; body: string }
  | { type: "action"; action: string; parameter: string; result?: string }
  | { type: "elicitation"; body: string }
  | { type: "response"; body: string }
  | { type: "error"; body: string };

export interface PlanStep {
  content: string;
  status: "pending" | "inProgress" | "completed" | "canceled";
}

/** What the dispatcher does to Linear on the steward's behalf: the agent panel, the delegate and the workflow state. */
export interface LinearAgentApi {
  /** Only thoughts and actions may be ephemeral (replaced by the next activity). */
  createActivity(sessionId: string, content: ActivityContent, opts?: { ephemeral?: boolean }): Promise<void>;
  /** Replaces the session's external links (e.g. the MR). */
  setExternalUrls(sessionId: string, urls: Array<{ label: string; url: string }>): Promise<void>;
  setPlan(sessionId: string, plan: PlanStep[]): Promise<void>;
  /** `null` removes the delegate. */
  setDelegate(issueId: string, appUserId: string | null): Promise<void>;
  /**
   * `{ type: "started" }` moves to the team's first started state unless the issue is already started or later;
   * `{ name }` moves to that state unless the issue is in it. "missing" when the team has no such state.
   */
  moveToState(issueId: string, which: { type: "started" } | { name: string }): Promise<"moved" | "already" | "missing">;
  issueState(issueId: string): Promise<{ type: string; name: string }>;
}

const EPHEMERAL_TYPES = new Set<ActivityContent["type"]>(["thought", "action"]);
/** State types at or past "started": an issue in one of these is not moved back to started. */
const STARTED_OR_LATER = new Set(["started", "completed", "canceled"]);

const ACTIVITY_CREATE = `mutation AgentActivityCreate($input: AgentActivityCreateInput!) {
  agentActivityCreate(input: $input) { success }
}`;
const SESSION_UPDATE = `mutation AgentSessionUpdate($id: String!, $input: AgentSessionUpdateInput!) {
  agentSessionUpdate(id: $id, input: $input) { success }
}`;
const ISSUE_DELEGATE = `mutation IssueDelegate($id: String!, $input: IssueUpdateInput!) {
  issueUpdate(id: $id, input: $input) { success }
}`;
const ISSUE_MOVE = `mutation IssueMove($id: String!, $input: IssueUpdateInput!) {
  issueUpdate(id: $id, input: $input) { success }
}`;
const ISSUE_STATE = `query IssueState($id: String!) {
  issue(id: $id) { state { type name } }
}`;
const ISSUE_STATES = `query IssueStates($id: String!) {
  issue(id: $id) { state { id type name } team { states(first: 250) { nodes { id name type position } } } }
}`;

const GraphqlResponse = z.object({
  data: z.record(z.string(), z.unknown()).nullish(),
  errors: z.array(z.object({ message: z.string().optional(), extensions: z.object({ code: z.string().optional() }).optional() })).optional(),
});
const MutationResult = z.object({ success: z.boolean() });
const State = z.object({ type: z.string(), name: z.string() });
const IssueStates = z.object({
  state: z.object({ id: z.string(), type: z.string(), name: z.string() }),
  team: z.object({ states: z.object({ nodes: z.array(z.object({ id: z.string(), name: z.string(), type: z.string(), position: z.number() })) }) }),
});

const operationName = (query: string): string => /^(?:query|mutation)\s+(\w+)/.exec(query)?.[1] ?? "request";

/** Sentinel for one rejected token: the caller invalidates it and retries once. */
class Unauthorized extends Error {}

/**
 * Linear's agent API over plain GraphQL with the app's token. A rejected token is invalidated and the call retried once
 * with a fresh one; a second rejection throws `LinearCredentialsRejectedError`.
 */
export const createLinearAgentApi = (token: LinearToken, fetchImpl: typeof fetch): LinearAgentApi => {
  const send = async (query: string, variables: Record<string, unknown>, accessToken: string): Promise<Record<string, unknown>> => {
    const operation = operationName(query);
    const response = await fetchImpl(LINEAR_GRAPHQL_URL, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${accessToken}` },
      body: JSON.stringify({ query, variables }),
    });
    const parsed = GraphqlResponse.safeParse(await response.json().catch(() => undefined));
    const errors = parsed.data?.errors ?? [];
    if (response.status === 401 || errors.some((error) => error.extensions?.code === "AUTHENTICATION_ERROR")) throw new Unauthorized();
    if (!response.ok) throw new Error(`Linear ${operation} answered ${response.status}`);
    const first = errors[0];
    if (first !== undefined) throw new Error(`Linear ${operation} failed: ${first.message ?? first.extensions?.code ?? "unknown error"}`);
    const data = parsed.data?.data;
    if (data === undefined || data === null) throw new Error(`Linear ${operation} returned no data`);
    return data;
  };

  const request = async (query: string, variables: Record<string, unknown>): Promise<Record<string, unknown>> => {
    for (let attempt = 0; ; attempt += 1) {
      const accessToken = await token.get();
      try {
        return await send(query, variables, accessToken);
      } catch (error) {
        if (!(error instanceof Unauthorized)) throw error;
        token.invalidate(accessToken);
        if (attempt > 0) throw new LinearCredentialsRejectedError();
      }
    }
  };

  const mutate = async (query: string, field: string, variables: Record<string, unknown>): Promise<void> => {
    const data = await request(query, variables);
    if (MutationResult.safeParse(data[field]).data?.success !== true) throw new Error(`Linear ${operationName(query)} was not successful`);
  };

  return {
    createActivity: async (sessionId, content, opts = {}) => {
      const ephemeral = opts.ephemeral ?? false;
      if (ephemeral && !EPHEMERAL_TYPES.has(content.type)) throw new Error(`a ${content.type} activity cannot be ephemeral`);
      await mutate(ACTIVITY_CREATE, "agentActivityCreate", { input: { agentSessionId: sessionId, content, ephemeral } });
    },
    setExternalUrls: (sessionId, urls) => mutate(SESSION_UPDATE, "agentSessionUpdate", { id: sessionId, input: { externalUrls: urls } }),
    setPlan: (sessionId, plan) => mutate(SESSION_UPDATE, "agentSessionUpdate", { id: sessionId, input: { plan } }),
    setDelegate: (issueId, appUserId) => mutate(ISSUE_DELEGATE, "issueUpdate", { id: issueId, input: { delegateId: appUserId } }),
    moveToState: async (issueId, which) => {
      const data = await request(ISSUE_STATES, { id: issueId });
      const issue = IssueStates.parse(data.issue);
      const states = issue.team.states.nodes;
      let target: { id: string } | undefined;
      if ("type" in which) {
        if (STARTED_OR_LATER.has(issue.state.type)) return "already";
        target = states.filter((state) => state.type === which.type).sort((a, b) => a.position - b.position)[0];
      } else {
        if (issue.state.name === which.name) return "already";
        target = states.find((state) => state.name === which.name);
      }
      if (target === undefined) return "missing";
      await mutate(ISSUE_MOVE, "issueUpdate", { id: issueId, input: { stateId: target.id } });
      return "moved";
    },
    issueState: async (issueId) => {
      const data = await request(ISSUE_STATE, { id: issueId });
      return State.parse(z.object({ state: z.unknown() }).parse(data.issue).state);
    },
  };
};
