import type { BrainConfig } from "../config/schema.js";

/** An MCP server the brain spawns: the steward's own servers on one host. */
export interface StdioMcpServerSpec {
  type?: "stdio";
  command: string;
  args: string[];
  env: Record<string, string>;
}

/** An MCP server the brain reaches over HTTP: a run pod's tools sidecar on localhost, which holds the credentials. */
export interface HttpMcpServerSpec {
  type: "http";
  url: string;
  headers?: Record<string, string>;
}

export type McpServerSpec = StdioMcpServerSpec | HttpMcpServerSpec;

export type BrainOutput = "implement" | "fix" | "chat";

export type ReasoningEffort = "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

export interface BrainInput {
  workspacePath: string;
  artifactsDir: string;
  transcriptPath: string;
  prompt: string;
  env: Record<string, string>;
  timeoutMs: number;
  maxTurns: number;
  model: string;
  /** openai-agents only. */
  reasoningEffort?: ReasoningEffort;
  mcpServers: Record<string, McpServerSpec>;
  /** Skills the openai-agents brain inlines into the prompt; unset inlines every skill in the worktree. */
  inlineSkills?: string[];
  denyPaths: string[];
  /** Which structured-output schema the run must return. */
  output: BrainOutput;
  /** claude-code only: the SDK session to resume; openai-agents refuses a run that sets it. */
  resumeSessionId?: string;
}

export interface BrainUsage {
  inputTokens: number;
  outputTokens: number;
  costUsd?: number;
}

export interface BrainRun {
  ok: boolean;
  output: unknown;
  usage?: BrainUsage;
  error?: string;
  /** claude-code: the SDK session id of the last result, the follow-up's after a max-turns follow-up. */
  sessionId?: string;
}

/** `BrainRun.error` when the run was aborted through the caller's AbortSignal. */
export const INTERRUPTED_ERROR = "interrupted";

/** `BrainRun.error` when a person stopped the run through its `BrainControl`; unlike an interrupt, never retried. */
export const STOPPED_ERROR = "stopped";

export type BrainKind = BrainConfig["kind"];

/** Steers or stops a running brain. Both are no-ops once the run has ended. */
export interface BrainControl {
  /** Delivers `message` to the agent as the next user message, between its turns. */
  steer(message: string): void;
  /** Interrupts the agent; the run returns `STOPPED_ERROR`. */
  stop(): void;
}

/** Called once when the run starts, with the handlers that steer and stop it. */
export type BrainControlSink = (handlers: BrainControl) => void;

export interface Brain {
  kind: BrainKind;
  run(input: BrainInput, onMessage: (line: string) => void, control?: BrainControlSink): Promise<BrainRun>;
}

export type OnMessage = (line: string) => void;
