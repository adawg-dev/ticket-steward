import { logger } from "../log.js";
import type { ActivityContent, LinearAgentApi, PlanStep } from "../tracker/linear/agent.js";
import type { PanelEvent } from "./activities.js";

/** Merged finished actions show this many parameters, then "+N more". */
const MAX_MERGED_PARAMETERS = 3;
/** Activities that are never dropped or merged; they also bound the merging of the ones around them. */
const KEPT_TYPES = new Set<ActivityContent["type"]>(["response", "elicitation", "error"]);

type Action = Extract<ActivityContent, { type: "action" }>;
type Activity = Extract<PanelEvent, { activity: ActivityContent }>;

const isActivity = (event: PanelEvent): event is Activity => "activity" in event;
const isFinishedAction = (event: PanelEvent): event is Activity & { activity: Action } =>
  isActivity(event) && !event.ephemeral && event.activity.type === "action" && event.activity.result !== undefined;

/** Several finished actions of one kind as one: their distinct parameters, and how many failed. */
const mergeActions = (actions: Action[]): Action => {
  const first = actions[0];
  if (first === undefined || actions.length === 1) return first ?? { type: "action", action: "", parameter: "" };
  const parameters = [...new Set(actions.map((action) => action.parameter).filter((parameter) => parameter !== ""))];
  const extra = parameters.length - MAX_MERGED_PARAMETERS;
  const parameter = [...parameters.slice(0, MAX_MERGED_PARAMETERS), ...(extra > 0 ? [`+${extra} more`] : [])].join(", ");
  const failed = actions.filter((action) => action.result !== "ok").length;
  return { type: "action", action: first.action, parameter, result: failed === 0 ? "ok" : `${failed} of ${actions.length} failed` };
};

/**
 * The queue as it is sent when behind: ephemerals dropped (all of them on flush, else all but a trailing one), plan
 * updates collapsed to the latest, and, between kept activities (response, elicitation, error), all thoughts merged
 * into one and the finished actions of each kind merged into one, each at its first one's place.
 */
const compact = (queue: PanelEvent[], dropAllEphemerals: boolean): PanelEvent[] => {
  const last = queue.length - 1;
  const kept = queue.filter((event, index) => !isActivity(event) || !event.ephemeral || (!dropAllEphemerals && index === last));
  const plans = kept.filter((event): event is { plan: PlanStep[] } => !isActivity(event));
  const latestPlan = plans[plans.length - 1];

  const out: PanelEvent[] = [];
  let planPlaced = false;
  let thought: { index: number; bodies: string[] } | null = null;
  let actions = new Map<string, { index: number; actions: Action[] }>();
  const closeSegment = (): void => {
    if (thought !== null) out[thought.index] = { activity: { type: "thought", body: thought.bodies.join("\n\n") }, ephemeral: false };
    for (const group of actions.values()) out[group.index] = { activity: mergeActions(group.actions), ephemeral: false };
    thought = null;
    actions = new Map();
  };
  for (const event of kept) {
    if (!isActivity(event)) {
      if (!planPlaced && latestPlan !== undefined) out.push(latestPlan);
      planPlaced = true;
    } else if (KEPT_TYPES.has(event.activity.type)) {
      closeSegment();
      out.push(event);
    } else if (!event.ephemeral && event.activity.type === "thought") {
      if (thought === null) {
        thought = { index: out.length, bodies: [] };
        out.push(event);
      }
      thought.bodies.push(event.activity.body);
    } else if (isFinishedAction(event)) {
      const group = actions.get(event.activity.action);
      if (group === undefined) {
        actions.set(event.activity.action, { index: out.length, actions: [event.activity] });
        out.push(event);
      } else group.actions.push(event.activity);
    } else out.push(event);
  }
  closeSegment();
  return out;
};

/**
 * Posts a run's panel events to the ticket's current Linear session, at most one Linear call per `intervalMs()`. When
 * events arrive faster, the queue is compacted before each call: ephemerals go first, then thoughts and finished actions
 * are merged, and plan updates collapse to the latest. Responses, elicitations and errors are never dropped. A failed
 * call is logged and skipped; events while the ticket has no session are dropped.
 */
export class ActivityPoster {
  private queue: PanelEvent[] = [];
  private nextAllowedAt = 0;
  private timerSet = false;
  private sending: Promise<void> | null = null;
  private flushing = false;

  constructor(
    private readonly p: {
      api: LinearAgentApi;
      sessionId: () => string | null;
      intervalMs: () => number;
      now: () => number;
      setTimer: typeof setTimeout;
    },
  ) {}

  push(event: PanelEvent): void {
    this.queue.push(event);
    this.schedule();
  }

  /** Sends everything queued except ephemerals, at once, after any call in flight. */
  async flush(): Promise<void> {
    this.flushing = true;
    try {
      if (this.sending !== null) await this.sending;
      while (this.queue.length > 0) {
        const [next, ...rest] = compact(this.queue, true);
        this.queue = rest;
        if (next !== undefined) await this.send(next);
      }
    } finally {
      this.flushing = false;
      this.nextAllowedAt = this.p.now() + this.p.intervalMs();
    }
  }

  private schedule(): void {
    if (this.timerSet || this.sending !== null || this.flushing || this.queue.length === 0) return;
    this.timerSet = true;
    this.p.setTimer(
      () => {
        this.timerSet = false;
        this.tick();
      },
      Math.max(0, this.nextAllowedAt - this.p.now()),
    );
  }

  private tick(): void {
    if (this.flushing || this.sending !== null) return;
    const [next, ...rest] = this.queue.length > 1 ? compact(this.queue, false) : this.queue;
    this.queue = rest;
    if (next === undefined) return;
    this.nextAllowedAt = this.p.now() + this.p.intervalMs();
    this.sending = this.send(next).finally(() => {
      this.sending = null;
      this.schedule();
    });
  }

  private async send(event: PanelEvent): Promise<void> {
    const sessionId = this.p.sessionId();
    if (sessionId === null) return;
    try {
      if (isActivity(event)) await this.p.api.createActivity(sessionId, event.activity, event.ephemeral ? { ephemeral: true } : {});
      else await this.p.api.setPlan(sessionId, event.plan);
    } catch (err) {
      logger.warn({ sessionId, err: err instanceof Error ? err.message : String(err) }, "linear panel post failed");
    }
  }
}
