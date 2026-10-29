export type TriggerEvent =
  | { kind: "cli"; issueId: string; identifier: string; teamKey: string; action?: "implement" }
  | {
      /**
       * Linear's agent panel: an implement (the steward was delegated the ticket, or a person answered its questions) or a
       * chat (a mention or a prompt), each in the ticket's agent session.
       */
      kind: "linear";
      run: "implement" | "chat";
      issueId: string;
      identifier: string;
      teamKey: string;
      /** The Linear agent session the work answers in; null on a job from the label trigger, which had none. */
      sessionId: string | null;
      /** What the person said: the mention, prompt or reply to the steward's questions; null on a fresh implement. */
      message: string | null;
      /** Who said it, when Linear named them (a prompt); absent on a delegation or mention. */
      author?: string;
    }
  | {
      kind: "loop";
      issueId: string;
      identifier: string;
      teamKey: string;
      loopId: number;
      step: LoopStep;
      /** Restart only: the restart came from a person re-adding the implement label. */
      labelDriven?: boolean;
    }
  | {
      /** A `chat.prefix` note on the ticket's merge request: resume its agent session with the message. */
      kind: "chat";
      issueId: string;
      identifier: string;
      teamKey: string;
      /** The ticket's loop when it has one (the chat then serializes with its steps), else null. */
      loopId: number | null;
      projectId: number;
      mrIid: number;
      /** Where the reply goes; null posts it on the merge request itself. */
      discussionId: string | null;
      noteId: number;
      author: string;
      /** The note without the prefix. */
      message: string;
    };

/** One step of a Greptile fix loop: wait for the MR's review, fix its findings, or restart a handed-back loop. */
export type LoopStep = "await" | "fix" | "restart";


export interface TicketBundle {
  id: string;
  identifier: string;
  url: string;
  title: string;
  description: string;
  team: { id: string; key: string; name: string };
  state: { name: string; type: string };
  labels: string[];
  priority: number;
  creator: { name: string; isBot: boolean } | null;
  createdAt: string;
  comments: Array<{ author: string; body: string; createdAt: string }>;
  attachments: Array<{ title: string; url: string }>;
  appliedTemplate: string | null;
  templates: Array<{ name: string; description: string; body: string; requiredFields: string[] }>;
}

/** An issue template and where it lives: `workspace`, or the key of the team that owns it. */
export interface TemplateListing {
  scope: string;
  template: TicketBundle["templates"][number];
}

/** Reads tickets as the steward's Linear app; the dispatcher alone holds its token. */
export interface Tracker {
  kind: "linear";
  resolveIssueId(idOrKey: string): Promise<{ id: string; identifier: string; teamKey: string }>;
  fetchTicket(issueId: string): Promise<TicketBundle>;
  readDescription(issueId: string): Promise<string>;
  /** The app's own Linear user id (`viewer { id }`), read once: delegation to it is delegation to the steward. */
  appUserId(): Promise<string>;
  /** True once Linear rejected the app's credentials; the worker stops claiming jobs until a restart. */
  credentialsRejected(): boolean;
}
