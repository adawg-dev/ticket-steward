import type { Secrets } from "../config/load.js";
import type { CodeHostConfig } from "../config/schema.js";
import { GitHubCodeHost } from "./github.js";
import { GitLabCodeHost } from "./gitlab.js";
import type { CodeHost } from "./types.js";

export type { ChangeRef, CodeHost } from "./types.js";
export { GitLabCodeHost } from "./gitlab.js";
export { GitHubCodeHost } from "./github.js";
export { recentCommits, type Commit } from "./gitlog.js";
export { codehostMcpSpec, startCodeHostMcpServer } from "./server.js";

export const createCodeHost = (config: CodeHostConfig, secrets: Secrets): CodeHost =>
  config.kind === "gitlab"
    ? new GitLabCodeHost({ baseUrl: config.baseUrl, project: config.project, token: secrets.GITLAB_TOKEN })
    : new GitHubCodeHost({ owner: config.owner, repo: config.repo, token: secrets.GITHUB_TOKEN });
