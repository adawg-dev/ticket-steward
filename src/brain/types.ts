import type { BrainConfig } from "../config/schema.js";

export interface McpServerSpec {
  command: string;
  args: string[];
  env: Record<string, string>;
}

export interface BrainInput {
  workspacePath: string;
  artifactsDir: string;
  transcriptPath: string;
  prompt: string;
  env: Record<string, string>;
  timeoutMs: number;
  maxTurns: number;
  model: string;
  mcpServers: Record<string, McpServerSpec>;
  denyPaths: string[];
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
}

/** `BrainRun.error` when the run was aborted through the caller's AbortSignal. */
export const INTERRUPTED_ERROR = "interrupted";

export type BrainKind = BrainConfig["kind"];

export interface Brain {
  kind: BrainKind;
  run(input: BrainInput, onMessage: (line: string) => void): Promise<BrainRun>;
}

export type OnMessage = (line: string) => void;
