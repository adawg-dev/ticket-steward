import { readFile, stat } from "node:fs/promises";
import { basename } from "node:path";
import { LinearClient, LinearError, LinearErrorType, type Comment, type Issue, type Template } from "@linear/sdk";
import type { TicketBundle, Tracker } from "../types.js";
import type { LinearAuth } from "./auth.js";
import { toTemplateSummary } from "./templates.js";

const WRITE_BACKOFF_MS = [500, 1000, 2000];
const UPLOAD_CACHE_CONTROL = "public, max-age=31536000";

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

const isUnauthorized = (error: unknown): boolean =>
  error instanceof LinearError && (error.status === 401 || error.type === LinearErrorType.AuthenticationError);

const commentAuthor = async (comment: Comment): Promise<string> => {
  const user = await comment.user;
  return user?.displayName ?? comment.botActor?.name ?? "unknown";
};

const isIssueTemplate = (template: Template): boolean => template.type === "issue";

export class LinearTracker implements Tracker {
  readonly kind = "linear";
  readonly agentSession: Tracker["agentSession"];
  private readonly fetchImpl: typeof fetch;
  private readonly clientFactory: (token: string) => LinearClient;

  constructor(
    private readonly auth: LinearAuth,
    opts: { fetchImpl?: typeof fetch; clientFactory?: (token: string) => LinearClient } = {},
  ) {
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.clientFactory = opts.clientFactory ?? ((token) => new LinearClient({ accessToken: token }));
    this.agentSession = {
      thought: (sessionId, body) => this.activity(sessionId, "thought", body),
      response: (sessionId, body) => this.activity(sessionId, "response", body),
      error: (sessionId, body) => this.activity(sessionId, "error", body),
    };
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

  async writeDescription(issueId: string, description: string): Promise<void> {
    await this.write((client) => client.updateIssue(issueId, { description }));
  }

  async postComment(issueId: string, body: string): Promise<void> {
    await this.write((client) => client.createComment({ issueId, body }));
  }

  async uploadFile(localPath: string, contentType: string): Promise<{ url: string }> {
    const [{ size }, content] = await Promise.all([stat(localPath), readFile(localPath)]);
    return this.write(async (client) => {
      const payload = await client.fileUpload(contentType, basename(localPath), size);
      const upload = payload.uploadFile;
      if (!payload.success || upload == null) throw new Error("Linear did not return an upload URL");
      const headers = new Headers({ "content-type": contentType, "cache-control": UPLOAD_CACHE_CONTROL });
      for (const { key, value } of upload.headers) headers.set(key, value);
      const response = await this.fetchImpl(upload.uploadUrl, { method: "PUT", headers, body: content });
      if (!response.ok) throw new Error(`Upload PUT answered ${response.status}`);
      return { url: upload.assetUrl };
    });
  }

  private async activity(sessionId: string, type: "thought" | "response" | "error", body: string): Promise<void> {
    await this.write((client) => client.createAgentActivity({ agentSessionId: sessionId, content: { type, body } }));
  }

  private async withAuth<T>(fn: (client: LinearClient) => Promise<T>): Promise<T> {
    try {
      return await fn(this.clientFactory(await this.auth.accessToken()));
    } catch (error) {
      if (!isUnauthorized(error)) throw error;
      return fn(this.clientFactory(await this.auth.handleUnauthorized()));
    }
  }

  private async write<T>(fn: (client: LinearClient) => Promise<T>): Promise<T> {
    let lastError: unknown;
    for (const [index, backoff] of WRITE_BACKOFF_MS.entries()) {
      try {
        return await this.withAuth(fn);
      } catch (error) {
        lastError = error;
        if (index < WRITE_BACKOFF_MS.length - 1) await sleep(backoff);
      }
    }
    throw lastError;
  }
}
