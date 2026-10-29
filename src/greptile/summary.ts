import type { MergeRequestInfo, MrDiscussion } from "../codehost/gitlabMr.js";

export interface GreptileSummary {
  body: string; score: number; reviewCount: number | null; lastReviewedSha: string | null;
  updatedAt: string; source: "description" | "note";
}

const SCORE_RE = /Confidence Score:\s*(\d)\s*\/\s*5/i;
const REVIEWS_RE = /Reviews \((\d+)\)/;
const LAST_REVIEWED_RE = /Last reviewed commit[\s\S]*?\b([0-9a-f]{7,40})\b/;

/** Parse a Greptile summary body; null when it carries no valid 0-5 confidence score. */
export const parseSummary = (body: string, updatedAt: string, source: GreptileSummary["source"]): GreptileSummary | null => {
  const scoreMatch = SCORE_RE.exec(body);
  if (!scoreMatch) return null;
  const score = Number(scoreMatch[1]);
  if (!Number.isInteger(score) || score < 0 || score > 5) return null;
  const reviews = REVIEWS_RE.exec(body);
  const sha = LAST_REVIEWED_RE.exec(body);
  return {
    body, score, updatedAt, source,
    reviewCount: reviews ? Number(reviews[1]) : null,
    lastReviewedSha: sha ? (sha[1] ?? null) : null,
  };
};

/** The newest Greptile summary: highest review count, ties broken by the newest update. */
export const findSummary = (mr: MergeRequestInfo, discussions: MrDiscussion[], botUsername: string): GreptileSummary | null => {
  const candidates: GreptileSummary[] = [];
  const fromDescription = parseSummary(mr.description, mr.updatedAt, "description");
  if (fromDescription) candidates.push(fromDescription);
  for (const d of discussions) {
    for (const n of d.notes) {
      if (n.author !== botUsername || n.system) continue;
      const s = parseSummary(n.body, n.updatedAt, "note");
      if (s) candidates.push(s);
    }
  }
  let best: GreptileSummary | null = null;
  for (const c of candidates) {
    if (!best) { best = c; continue; }
    const diff = (c.reviewCount ?? -1) - (best.reviewCount ?? -1);
    if (diff > 0 || (diff === 0 && Date.parse(c.updatedAt) >= Date.parse(best.updatedAt))) best = c;
  }
  return best;
};

/** Whether a (possibly abbreviated) reviewed sha is a prefix of the full sha; needs at least 7 hex chars. */
export const shaMatches = (short: string | null, full: string): boolean =>
  short !== null && /^[0-9a-f]{7,40}$/i.test(short) && full.toLowerCase().startsWith(short.toLowerCase());
