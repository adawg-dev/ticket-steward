import type { BrainConfig } from "../config/schema.js";
import { createClaudeCodeBrain } from "./claudeCode.js";
import { createFakeBrain, FAKE_BRAIN_KIND } from "./fake.js";
import { createOpenAiAgentsBrain } from "./openaiAgents.js";
import type { Brain } from "./types.js";

export type { Brain, BrainInput, BrainRun, BrainUsage, McpServerSpec, BrainKind } from "./types.js";
export { buildBrainEnv } from "./env.js";
export { evaluateTool } from "./policy.js";
export type { PolicyDecision } from "./policy.js";
export { runBrainDetached } from "./spawn.js";

export const createBrain = (config: BrainConfig): Brain => {
  const kind: string = config.kind;
  if (kind === FAKE_BRAIN_KIND && process.env.NODE_ENV === "test") return createFakeBrain();
  switch (config.kind) {
    case "claude-code":
      return createClaudeCodeBrain();
    case "openai-agents":
      return createOpenAiAgentsBrain();
  }
};
