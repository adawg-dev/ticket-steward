import { z } from "zod";

export const LEVELS = ["small", "standard", "design"] as const;
export type Level = (typeof LEVELS)[number];
export const LevelSchema = z.enum(LEVELS);

export const levelRank = (level: Level): number => LEVELS.indexOf(level);

export const higher = (a: Level, b: Level): Level => (levelRank(b) > levelRank(a) ? b : a);

/** The highest of: the level carried from an earlier run, design when the ticket has the design label, and the default. */
export const chooseLevel = (p: { labels: readonly string[]; designLabel: string | undefined; defaultLevel: "small" | "standard"; carried: Level | null }): Level => {
  const wanted = p.designLabel?.toLowerCase();
  const labelled = wanted !== undefined && p.labels.some((label) => label.toLowerCase() === wanted);
  return higher(higher(p.defaultLevel, p.carried ?? p.defaultLevel), labelled ? "design" : p.defaultLevel);
};
