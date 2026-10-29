import { LinearClient, LinearError, LinearErrorType, type Comment, type Issue, type Template } from "@linear/sdk";
import { logger } from "../../log.js";
import type { TicketBundle, Tracker } from "../types.js";
import { LinearCredentialsRejectedError, type LinearToken } from "./auth.js";
import { toTemplateSummary } from "./templates.js";

const isUnauthorized = (error: unknown): boolean =>
  error instanceof LinearError && (error.status === 401 || error.type === LinearErrorType.AuthenticationError);

const commentAuthor = async (comment: Comment): Promise<string> => {
  const user = await comment.user;
  return user?.displayName ?? comment.botActor?.name ?? "unknown";
};

const isIssueTemplate = (template: Template): boolean => template.type === "issue";

/** The app's OAuth access token goes out as `Authorization: Bearer <token>`. */
export const createLinearClient = (accessToken: string): LinearClient => new LinearClient({ accessToken });

export class LinearTracker implements Tracker {
  readonly kind = "linear";
  private readonly clientFactory: (accessToken: string) => LinearClient;
  private client: { accessToken: string; client: LinearClient } | null = null;
  private appUser: Promise<string> | null = null;
  private rejected = false;

  constructor(
    private readonly token: LinearToken,
    opts: { clientFactory?: (accessToken: string) => LinearClient } = {},
  ) {
    this.clientFactory = opts.clientFactory ?? createLinearClient;
  }

  credentialsRejected(): boolean {
    return this.rejected;
  }

  /** The app's own Linear user (`viewer { id }`): an issue delegated to it is delegated to the steward. */
  appUserId(): Promise<string> {
    this.appUser ??= this.withAuth(async (client) => (await client.viewer).id).catch((error: unknown) => {
      this.appUser = null;
      throw error;
    });
    return this.appUser;
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

  /**
   * Runs `fn` with a client for the current token. A 401 invalidates the token and retries once with a fresh one; a
   * second 401, or a refused mint, throws `LinearCredentialsRejectedError` and latches `credentialsRejected()`.
   */
  private async withAuth<T>(fn: (client: LinearClient) => Promise<T>): Promise<T> {
    for (let attempt = 0; ; attempt += 1) {
      const accessToken = await this.token.get().catch((error: unknown) => {
        if (error instanceof LinearCredentialsRejectedError) this.reject(error);
        throw error;
      });
      try {
        return await fn(this.clientFor(accessToken));
      } catch (error) {
        if (!isUnauthorized(error)) throw error;
        this.token.invalidate(accessToken);
        if (attempt === 0) continue;
        const rejected = new LinearCredentialsRejectedError();
        this.reject(rejected);
        throw rejected;
      }
    }
  }

  private clientFor(accessToken: string): LinearClient {
    if (this.client?.accessToken !== accessToken) this.client = { accessToken, client: this.clientFactory(accessToken) };
    return this.client.client;
  }

  /** Logs loudly the first time: the worker stops claiming jobs until the steward restarts. */
  private reject(error: LinearCredentialsRejectedError): void {
    if (!this.rejected) logger.error({ err: error.message }, "Linear rejected the app's credentials; the worker stops claiming jobs until the steward restarts");
    this.rejected = true;
  }
}
