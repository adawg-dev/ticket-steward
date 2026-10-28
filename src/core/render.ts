export const truncate = (s: string, max: number): string => (s.length <= max ? s : `${s.slice(0, max - 1)}…`);

/** Markers around the agent brief that enrich (removed 2026-10-28) wrote into ticket descriptions; implement still reads them. */
export const BRIEF_BEGIN = "<!-- ticket-steward:brief:begin -->";
export const BRIEF_END = "<!-- ticket-steward:brief:end -->";

/** True when a comment with this body's first line (which names the job) is already on the ticket: a publish retry must not post it twice. */
export const alreadyCommented = (comments: ReadonlyArray<{ body: string }>, body: string): boolean => {
  const head = body.split("\n", 1)[0]?.trim() ?? "";
  return head !== "" && comments.some((comment) => comment.body.split("\n", 1)[0]?.trim() === head);
};
