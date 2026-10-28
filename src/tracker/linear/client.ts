import { LinearClient, LinearError, LinearErrorType, type Comment, type Issue, type Template } from "@linear/sdk";
import { logger } from "../../log.js";
import type { TicketBundle, Tracker } from "../types.js";
import { toTemplateSummary } from "./templates.js";

const WRITE_BACKOFF_MS = [500, 1000, 2000];

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

const isUnauthorized = (error: unknown): boolean =>
  error instanceof LinearError && (error.status === 401 || error.type === LinearErrorType.AuthenticationError);

const commentAuthor = async (comment: Comment): Promise<string> => {
  const user = await comment.user;
  return user?.displayName ?? comment.botActor?.name ?? "unknown";
};

const isIssueTemplate = (template: Template): boolean => template.type === "issue";

/** A personal API key goes out as a raw `Authorization: <key>` header; `accessToken` would add `Bearer`. */
export const createLinearClient = (apiKey: string): LinearClient => new LinearClient({ apiKey });

/** Linear answered 401: the personal API key is invalid or was revoked. Retrying cannot help. */
export class LinearApiKeyRejectedError extends Error {
  constructor() {
    super("Linear rejected LINEAR_API_KEY (401): the key is invalid or revoked. Create a new personal API key, update .env and restart the steward.");
    this.name = "LinearApiKeyRejectedError";
  }
}

/** A team's own label wins over a workspace label of the same name. */
const labelIdFor = async (client: LinearClient, name: string, teamId: string | null): Promise<string> => {
  const found = await client.issueLabels({ filter: { name: { eqIgnoreCase: name } } });
  const owners = await Promise.all(found.nodes.map(async (label) => ({ id: label.id, teamId: (await label.team)?.id ?? null })));
  const match = owners.find((owner) => owner.teamId !== null && owner.teamId === teamId) ?? owners.find((owner) => owner.teamId === null);
  if (match === undefined) throw new Error(`Linear label "${name}" does not exist for this team or the workspace`);
  return match.id;
};

export class LinearTracker implements Tracker {
  readonly kind = "linear";
  private readonly client: LinearClient;
  private rejected = false;

  constructor(apiKey: string, opts: { clientFactory?: (apiKey: string) => LinearClient } = {}) {
    this.client = (opts.clientFactory ?? createLinearClient)(apiKey);
  }

  apiKeyRejected(): boolean {
    return this.rejected;
  }

  async resolveIssueId(idOrKey: string): Promise<{ id: string; identifier: string; teamKey: string }> {
    return this.withAuth(async (client) => {
      const issue = await client.issue(idOrKey);
      const team = await issue.team;
      if (team === undefined) throw new Error(`Issue ${idOrKey} has no team`);
      return { id: issue.id, identifier: issue.identifier, teamKey: team.key };
    });
  }

  async fetchTicket(issueId: string): Promise<TicketBundle> {
    return this.withAuth(async (client) => {
      const issue = await client.issue(issueId);
      const [team, state, labels, creator, comments, attachments, appliedTemplate, organization] = await Promise.all([
        issue.team,
        issue.state,
        issue.labels(),
        issue.creator,
        issue.comments(),
        issue.attachments(),
        issue.lastAppliedTemplate,
        client.organization,
      ]);
      if (team === undefined) throw new Error(`Issue ${issueId} has no team`);
      if (state === undefined) throw new Error(`Issue ${issueId} has no state`);
      const [workspaceTemplates, teamTemplates, authors] = await Promise.all([
        organization.templates(),
        team.templates(),
        Promise.all(comments.nodes.map(commentAuthor)),
      ]);
      return {
        id: issue.id,
        identifier: issue.identifier,
        url: issue.url,
        title: issue.title,
        description: issue.description ?? "",
        team: { id: team.id, key: team.key, name: team.name },
        state: { name: state.name, type: state.type },
        labels: labels.nodes.map((label) => label.name),
        priority: issue.priority,
        creator: creator === undefined ? null : { name: creator.displayName, isBot: false },
        createdAt: issue.createdAt.toISOString(),
        comments: comments.nodes.map((comment, index) => ({
          author: authors[index] ?? "unknown",
          body: comment.body,
          createdAt: comment.createdAt.toISOString(),
        })),
        attachments: attachments.nodes.map(({ title, url }) => ({ title, url })),
        appliedTemplate: appliedTemplate?.name ?? null,
        templates: [...workspaceTemplates.nodes, ...teamTemplates.nodes].filter(isIssueTemplate).map(toTemplateSummary),
      };
    });
  }

  async readDescription(issueId: string): Promise<string> {
    const issue: Issue = await this.withAuth((client) => client.issue(issueId));
    return issue.description ?? "";
  }

  async swapLabel(issueId: string, from: string, to: string): Promise<void> {
    await this.write(async (client) => {
      const issue = await client.issue(issueId);
      const [labels, team] = await Promise.all([issue.labels(), issue.team]);
      const target = await labelIdFor(client, to, team?.id ?? null);
      const wanted = from.toLowerCase();
      const current = labels.nodes.find((label) => label.name.toLowerCase() === wanted);
      const added = labels.nodes.some((label) => label.id === target) ? [] : [target];
      const removed = current === undefined || current.id === target ? [] : [current.id];
      if (added.length === 0 && removed.length === 0) return;
      // One update, never two: labels in an exclusive Linear group cannot both sit on an issue, even briefly.
      await client.updateIssue(issueId, { addedLabelIds: added, removedLabelIds: removed });
    });
  }

  /** Maps a 401 to `LinearApiKeyRejectedError` and latches `apiKeyRejected()`, logging loudly the first time. */
  private async withAuth<T>(fn: (client: LinearClient) => Promise<T>): Promise<T> {
    try {
      return await fn(this.client);
    } catch (error) {
      if (!isUnauthorized(error)) throw error;
      const rejected = new LinearApiKeyRejectedError();
      if (!this.rejected) logger.error({ err: rejected.message }, "Linear API key rejected; the worker stops claiming jobs until the steward restarts");
      this.rejected = true;
      throw rejected;
    }
  }

  private async write<T>(fn: (client: LinearClient) => Promise<T>): Promise<T> {
    let lastError: unknown;
    for (const [index, backoff] of WRITE_BACKOFF_MS.entries()) {
      try {
        return await this.withAuth(fn);
      } catch (error) {
        if (error instanceof LinearApiKeyRejectedError) throw error;
        lastError = error;
        if (index < WRITE_BACKOFF_MS.length - 1) await sleep(backoff);
      }
    }
    throw lastError;
  }
}
