import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { Brain, BrainInput, BrainRun, BrainUsage } from "../../src/brain/types.js";

export interface FakeBrainOptions {
  result?: unknown;
  writeFiles?: Record<string, string>;
  fail?: boolean;
  usage?: BrainUsage;
}

export class FakeBrain implements Brain {
  readonly kind = "claude-code";
  private readonly inputs: BrainInput[] = [];

  constructor(private readonly options: FakeBrainOptions = {}) {}

  get runs(): number {
    return this.inputs.length;
  }

  lastInput(): BrainInput {
    const last = this.inputs.at(-1);
    if (last === undefined) throw new Error("fake brain has not run");
    return last;
  }

  async run(input: BrainInput, onMessage: (line: string) => void): Promise<BrainRun> {
    this.inputs.push(input);
    onMessage(JSON.stringify({ type: "fake", prompt: input.prompt }));
    for (const [file, content] of Object.entries(this.options.writeFiles ?? {})) {
      const target = join(input.artifactsDir, file);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, content);
    }
    if (this.options.fail === true) return { ok: false, output: undefined, error: "fake brain failure" };
    const usage = this.options.usage ?? { inputTokens: 10, outputTokens: 5 };
    return { ok: true, output: this.options.result, usage };
  }
}
