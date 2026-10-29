import { z } from "zod";
import { nowIso, readStored, type Database } from "./db.js";

/**
 * Where a ticket's Greptile fix loop stands; `passed`, `handed_back` and `stopped` are ended. `unassigned` (the steward was
 * removed as the ticket's delegate) is neither active nor ended: the loop is parked until it is revived.
 */
export type LoopState = "awaiting_mr" | "awaiting_review" | "fixing" | "passed" | "handed_back" | "stopped" | "unassigned";

export const ACTIVE_LOOP_STATES: readonly LoopState[] = ["awaiting_mr", "awaiting_review", "fixing"];

/** One review round: the head Greptile reviewed, its verdict, and what the fix did with it. */
export interface LoopRound {
  round: number;
  headSha: string;
  score: number | null;
  pipeline: string | null;
  fixed: number;
  declined: number;
  outcome: "changed" | "no_changes" | "passed" | "handed_back";
}

/** CI triage's retries of one job (by name) on one commit: infrastructure failures and flaky-looking ones apart. */
export interface CiRetry { sha: string; infra: number; flaky: number }
export type CiRetries = Record<string, CiRetry>;

/** One ticket's fix loop, from the implement push to its end. `headSha` is the last SHA the steward pushed. */
export interface Loop {
  id: number;
  issueId: string;
  identifier: string;
  teamKey: string;
  implementJobId: number;
  branch: string;
  baseSha: string;
  headSha: string;
  worktreeName: string;
  labelDriven: boolean;
  projectId: number | null;
  mrIid: number | null;
  mrUrl: string | null;
  sessionId: string | null;
  round: number;
  state: LoopState;
  history: LoopRound[];
  /** Lasting instructions people gave about the MR ("keep X", "don't Y"), one line each; every later run is shown them. */
  decisions: string[];
  waitStartedAt: string | null;
  reviewCountAtTrigger: number | null;
  adoptedFrom: string | null;
  /** A fix commit made but not yet published, so a retry pushes it instead of running the brain again. */
  pendingPush: { sha: string; pushed: boolean } | null;
  /** When the loop was last handed back; comments after it are new to a restarted loop. */
  handedBackAt: string | null;
  /** The first MR note of the batch the queued await is waiting out; the batch's round starts no later than twice the quiet window after it. */
  pendingNotesSince: string | null;
  /** Rounds in a row that only bot notes or a red pipeline started; capped by `greptile.maxRounds`, reset by a person's round. */
  botRounds: number;
  /** CI triage's retries by job name, for the commit each was last retried on; another commit starts the job's count again. */
  ciRetries: CiRetries;
  endedAt: string | null;
  createdAt: string;
}

export type NewLoop = Pick<
  Loop,
  "issueId" | "identifier" | "teamKey" | "implementJobId" | "branch" | "baseSha" | "headSha" | "worktreeName" | "labelDriven" | "sessionId"
>;

export type LoopPatch = Partial<Omit<Loop, "id" | "issueId" | "identifier" | "teamKey" | "implementJobId" | "createdAt">>;

const ENDED_STATES: readonly LoopState[] = ["passed", "handed_back", "stopped"];

const LoopStateSchema = z.enum(["awaiting_mr", "awaiting_review", "fixing", "passed", "handed_back", "stopped", "unassigned"]);

const LoopRoundSchema = z.object({
  round: z.number().int(),
  headSha: z.string(),
  score: z.number().nullable(),
  pipeline: z.string().nullable(),
  fixed: z.number().int(),
  declined: z.number().int(),
  outcome: z.enum(["changed", "no_changes", "passed", "handed_back"]),
});

const HistorySchema = z.array(LoopRoundSchema);

const DecisionsSchema = z.array(z.string());

const PendingPushSchema = z.object({ sha: z.string(), pushed: z.boolean() });

const CiRetriesSchema = z.record(z.string(), z.object({ sha: z.string(), infra: z.number().int(), flaky: z.number().int() }));

type LoopJsonColumn = "history" | "decisions" | "pending_push" | "ci_retries";

interface LoopRow {
  id: number;
  issue_id: string;
  identifier: string;
  team_key: string;
  implement_job_id: number;
  branch: string;
  base_sha: string;
  head_sha: string;
  worktree_name: string;
  label_driven: number;
  project_id: number | null;
  mr_iid: number | null;
  mr_url: string | null;
  session_id: string | null;
  round: number;
  state: string;
  history: string;
  decisions: string;
  wait_started_at: string | null;
  review_count_at_trigger: number | null;
  adopted_from: string | null;
  pending_push: string | null;
  handed_back_at: string | null;
  pending_notes_since: string | null;
  bot_rounds: number;
  ci_retries: string;
  ended_at: string | null;
  created_at: string;
}

/**
 * The loop, plus the JSON columns that could not be read: an unreadable history (or CI retry record) reads as empty and an
 * unreadable pending push as null. An unknown state reads as `stopped`, so the loop is never driven from a row it does not understand.
 */
const toLoop = (row: LoopRow): { loop: Loop; unreadable: LoopJsonColumn[] } => {
  const unreadable: LoopJsonColumn[] = [];
  const state = LoopStateSchema.safeParse(row.state);
  const loop: Loop = {
    id: row.id,
    issueId: row.issue_id,
    identifier: row.identifier,
    teamKey: row.team_key,
    implementJobId: row.implement_job_id,
    branch: row.branch,
    baseSha: row.base_sha,
    headSha: row.head_sha,
    worktreeName: row.worktree_name,
    labelDriven: row.label_driven === 1,
    projectId: row.project_id,
    mrIid: row.mr_iid,
    mrUrl: row.mr_url,
    sessionId: row.session_id,
    round: row.round,
    state: state.success ? state.data : "stopped",
    history: readStored(row.history, "history", HistorySchema, unreadable) ?? [],
    decisions: readStored(row.decisions, "decisions", DecisionsSchema, unreadable) ?? [],
    waitStartedAt: row.wait_started_at,
    reviewCountAtTrigger: row.review_count_at_trigger,
    adoptedFrom: row.adopted_from,
    pendingPush: readStored(row.pending_push, "pending_push", PendingPushSchema, unreadable),
    handedBackAt: row.handed_back_at,
    pendingNotesSince: row.pending_notes_since,
    botRounds: row.bot_rounds,
    ciRetries: readStored(row.ci_retries, "ci_retries", CiRetriesSchema, unreadable) ?? {},
    endedAt: row.ended_at,
    createdAt: row.created_at,
  };
  return { loop, unreadable };
};

type SqlValue = string | number | null;

/** Each patchable field's column and its stored form. */
const PATCH_COLUMNS: { [K in keyof Required<LoopPatch>]: { column: string; store: (value: Required<LoopPatch>[K]) => SqlValue } } = {
  branch: { column: "branch", store: (value) => value },
  baseSha: { column: "base_sha", store: (value) => value },
  headSha: { column: "head_sha", store: (value) => value },
  worktreeName: { column: "worktree_name", store: (value) => value },
  labelDriven: { column: "label_driven", store: (value) => (value ? 1 : 0) },
  projectId: { column: "project_id", store: (value) => value },
  mrIid: { column: "mr_iid", store: (value) => value },
  mrUrl: { column: "mr_url", store: (value) => value },
  sessionId: { column: "session_id", store: (value) => value },
  round: { column: "round", store: (value) => value },
  state: { column: "state", store: (value) => value },
  history: { column: "history", store: (value) => JSON.stringify(value) },
  decisions: { column: "decisions", store: (value) => JSON.stringify(value) },
  waitStartedAt: { column: "wait_started_at", store: (value) => value },
  reviewCountAtTrigger: { column: "review_count_at_trigger", store: (value) => value },
  adoptedFrom: { column: "adopted_from", store: (value) => value },
  pendingPush: { column: "pending_push", store: (value) => (value === null ? null : JSON.stringify(value)) },
  handedBackAt: { column: "handed_back_at", store: (value) => value },
  pendingNotesSince: { column: "pending_notes_since", store: (value) => value },
  botRounds: { column: "bot_rounds", store: (value) => value },
  ciRetries: { column: "ci_retries", store: (value) => JSON.stringify(value) },
  endedAt: { column: "ended_at", store: (value) => value },
};

const isPatchKey = (key: string): key is keyof LoopPatch => Object.hasOwn(PATCH_COLUMNS, key);

/** One set clause for a patch field; generic so the field's value and its column's store function line up. */
const assignment = <K extends keyof LoopPatch>(key: K, value: Required<LoopPatch>[K]): { column: string; value: SqlValue } => ({
  column: PATCH_COLUMNS[key].column,
  value: PATCH_COLUMNS[key].store(value),
});

/** A decision's identity for deduplication: case, runs of whitespace and a trailing full stop do not make it new. */
const decisionKey = (decision: string): string => decision.trim().replace(/\s+/g, " ").replace(/[.!]+$/, "").toLowerCase();

/** `existing` followed by the decisions in `added` that are not blank and not already there, each trimmed. */
export const mergeDecisions = (existing: readonly string[], added: readonly string[]): string[] => {
  const seen = new Set(existing.map(decisionKey));
  const merged = [...existing];
  for (const decision of added) {
    const key = decisionKey(decision);
    if (key === "" || seen.has(key)) continue;
    seen.add(key);
    merged.push(decision.trim().replace(/\s+/g, " "));
  }
  return merged;
};

/** The fix loop records, one per loop; a ticket may have several over time, the latest being its current one. */
export class LoopStore {
  private readonly insert;
  private readonly selectById;
  private readonly selectByImplementJob;
  private readonly selectLatestForIssue;
  private readonly selectLatestForBranch;
  private readonly selectActive;
  private readonly selectStranded;
  private readonly selectKept;
  private readonly selectSessionWorktrees;
  private readonly storeHistory;
  private readonly storeDecisions;

  constructor(private readonly db: Database) {
    this.insert = db.prepare<[string, string, string, number, string, string, string, string, number, string | null, string, string]>(
      `INSERT INTO loops (issue_id, identifier, team_key, implement_job_id, branch, base_sha, head_sha, worktree_name, label_driven,
         session_id, round, state, history, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, '[]', ?)`,
    );
    this.selectById = db.prepare<[number], LoopRow>("SELECT * FROM loops WHERE id = ?");
    this.selectByImplementJob = db.prepare<[number], LoopRow>("SELECT * FROM loops WHERE implement_job_id = ? ORDER BY id DESC LIMIT 1");
    this.selectLatestForIssue = db.prepare<[string], LoopRow>("SELECT * FROM loops WHERE issue_id = ? ORDER BY id DESC LIMIT 1");
    this.selectLatestForBranch = db.prepare<[string], LoopRow>("SELECT * FROM loops WHERE branch = ? ORDER BY id DESC LIMIT 1");
    this.selectActive = db.prepare<string[], LoopRow>(
      `SELECT * FROM loops WHERE state IN (${ACTIVE_LOOP_STATES.map(() => "?").join(", ")}) ORDER BY id`,
    );
    // A loop job's subject is `loop:<id>` (`loopSubject` in jobs.ts).
    this.selectStranded = db.prepare<string[], LoopRow>(
      `SELECT * FROM loops l WHERE l.state IN (${ACTIVE_LOOP_STATES.map(() => "?").join(", ")})
         AND NOT EXISTS (SELECT 1 FROM jobs j WHERE j.subject = 'loop:' || l.id AND j.kind <> 'chat' AND j.status IN ('queued', 'running'))
       ORDER BY l.id`,
    );
    this.selectKept = db.prepare<[string], LoopRow>("SELECT * FROM loops WHERE ended_at IS NULL OR ended_at >= ? ORDER BY id");
    // Like jobs' sessions: active while the loop runs, then until the ticket's last job, hand-back or end is `since` old.
    this.selectSessionWorktrees = db.prepare<[string, string], { worktree_name: string }>(
      `SELECT DISTINCT l.worktree_name FROM loops l
       WHERE l.session_id IS NOT NULL
         AND (l.ended_at IS NULL
           OR MAX(l.created_at, COALESCE(l.handed_back_at, ''), l.ended_at) >= ?
           OR EXISTS (SELECT 1 FROM jobs a WHERE a.issue_id = l.issue_id AND COALESCE(a.finished_at, a.started_at, a.created_at) >= ?))
       ORDER BY l.worktree_name`,
    );
    this.storeHistory = db.prepare<[string, number]>("UPDATE loops SET history = ? WHERE id = ?");
    this.storeDecisions = db.prepare<[string, number]>("UPDATE loops SET decisions = ? WHERE id = ?");
  }

  /** A new loop waiting for its MR, at round 0 with no history. */
  create(input: NewLoop): number {
    const state: LoopState = "awaiting_mr";
    const { lastInsertRowid } = this.insert.run(
      input.issueId,
      input.identifier,
      input.teamKey,
      input.implementJobId,
      input.branch,
      input.baseSha,
      input.headSha,
      input.worktreeName,
      input.labelDriven ? 1 : 0,
      input.sessionId,
      state,
      nowIso(),
    );
    return Number(lastInsertRowid);
  }

  get(id: number): Loop | null {
    const row = this.selectById.get(id);
    return row === undefined ? null : toLoop(row).loop;
  }

  forImplementJob(jobId: number): Loop | null {
    const row = this.selectByImplementJob.get(jobId);
    return row === undefined ? null : toLoop(row).loop;
  }

  latestForIssue(issueId: string): Loop | null {
    const row = this.selectLatestForIssue.get(issueId);
    return row === undefined ? null : toLoop(row).loop;
  }

  /** The newest loop on `branch`; chat finds a ticket by its MR's source branch. */
  latestForBranch(branch: string): Loop | null {
    const row = this.selectLatestForBranch.get(branch);
    return row === undefined ? null : toLoop(row).loop;
  }

  /** Loops still running (awaiting the MR or a review, or fixing), oldest first. */
  active(): Loop[] {
    return this.selectActive.all(...ACTIVE_LOOP_STATES).map((row) => toLoop(row).loop);
  }

  /**
   * Running loops with no queued or running job: their last step ended for good (failed, or out of attempts), so nothing
   * would move them again. One statement, so a step handing over to the next (one transaction) is never caught in between.
   */
  stranded(): Loop[] {
    return this.selectStranded.all(...ACTIVE_LOOP_STATES).map((row) => toLoop(row).loop);
  }

  /**
   * Writes the given fields; moving to an ended state also stamps `endedAt` unless the patch sets it. With `onlyIn`, only while the loop is in one of those states (checked in the same statement), so a
   * step that read the loop earlier never overwrites a state another writer set meanwhile (the steward unassigned).
   * True when a row changed.
   */
  update(id: number, patch: LoopPatch, onlyIn?: readonly LoopState[]): boolean {
    const sets: Array<{ column: string; value: SqlValue }> = [];
    for (const key of Object.keys(patch)) {
      if (!isPatchKey(key)) continue;
      const value = patch[key];
      if (value === undefined) continue;
      sets.push(assignment(key, value));
    }
    if (patch.state !== undefined && ENDED_STATES.includes(patch.state) && patch.endedAt === undefined) {
      sets.push({ column: "ended_at", value: nowIso() });
    }
    if (sets.length === 0) return false;
    const guard = onlyIn === undefined ? "" : ` AND state IN (${onlyIn.map(() => "?").join(", ")})`;
    const result = this.db
      .prepare<SqlValue[]>(`UPDATE loops SET ${sets.map(({ column }) => `${column} = ?`).join(", ")} WHERE id = ?${guard}`)
      .run(...sets.map(({ value }) => value), id, ...(onlyIn ?? []));
    return result.changes > 0;
  }

  /** Loops not ended, or ended within the last `days`: the ones whose worktree and sessions retention keeps. */
  keptWithin(days: number): Loop[] {
    const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
    return this.selectKept.all(cutoff.toISOString()).map((row) => toLoop(row).loop);
  }

  /** Worktree names of loop sessions not ended or active at or after `since`; retention keeps their session dirs. */
  sessionWorktreesActiveSince(since: Date): string[] {
    const at = since.toISOString();
    return this.selectSessionWorktrees.all(at, at).map((row) => row.worktree_name);
  }

  /** Adds a round to the history; throws rather than overwrite a stored history it cannot read. */
  appendRound(id: number, round: LoopRound): void {
    this.db.transaction(() => {
      const row = this.selectById.get(id);
      if (row === undefined) throw new Error(`loop ${id} not found`);
      const { loop, unreadable } = toLoop(row);
      if (unreadable.includes("history")) throw new Error(`loop ${id}: stored history is unreadable; fix the column before adding a round`);
      this.storeHistory.run(JSON.stringify([...loop.history, round]), id);
    })();
  }

  /** Adds the decisions not already recorded (`mergeDecisions`); throws rather than overwrite stored decisions it cannot read. */
  appendDecisions(id: number, decisions: readonly string[]): void {
    this.db.transaction(() => {
      const row = this.selectById.get(id);
      if (row === undefined) throw new Error(`loop ${id} not found`);
      const { loop, unreadable } = toLoop(row);
      if (unreadable.includes("decisions")) throw new Error(`loop ${id}: stored decisions are unreadable; fix the column before adding one`);
      const merged = mergeDecisions(loop.decisions, decisions);
      if (merged.length !== loop.decisions.length) this.storeDecisions.run(JSON.stringify(merged), id);
    })();
  }
}
