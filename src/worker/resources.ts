import { availableParallelism, freemem, loadavg } from "node:os";

import type { ResourceGuardConfig } from "../config/schema.js";

export interface ResourceSample {
  availableMemoryMb: number;
  loadPerCpu: number;
}

const MB = 1024 * 1024;

/** The host's available memory (libuv reads MemAvailable on Linux) and its 1-minute load per CPU. */
export const sampleResources = (): ResourceSample => {
  const [oneMinute = 0] = loadavg();
  return { availableMemoryMb: Math.round(freemem() / MB), loadPerCpu: oneMinute / availableParallelism() };
};

/** A held heavy start: a shortage is worth a log line, spacing is a routine pause. */
export interface Hold {
  cause: "shortage" | "spacing";
  reason: string;
}

/** Why a heavy job may not start now, or null when it may; `sinceLastStartMs` is the time since the last heavy start. */
export const holdReason = (guard: ResourceGuardConfig, sample: ResourceSample, sinceLastStartMs: number): Hold | null => {
  if (!guard.enabled) return null;
  if (sample.availableMemoryMb < guard.minAvailableMemoryMb) {
    return { cause: "shortage", reason: `available memory ${Math.round(sample.availableMemoryMb)} MB is under ${guard.minAvailableMemoryMb} MB` };
  }
  if (sample.loadPerCpu > guard.maxLoadPerCpu) {
    return { cause: "shortage", reason: `load per CPU ${sample.loadPerCpu.toFixed(2)} is over ${guard.maxLoadPerCpu}` };
  }
  if (sinceLastStartMs < guard.startSpacingSeconds * 1000) {
    return { cause: "spacing", reason: `last heavy job started ${Math.round(sinceLastStartMs / 1000)}s ago, spacing is ${guard.startSpacingSeconds}s` };
  }
  return null;
};
