import { z } from "zod";

/** The hidden marker on every steward chat reply; intake never answers a note carrying it, so the steward never answers itself. */
export const CHAT_MARKER = "<!-- ticket-steward:chat -->";

export const NO_SESSION_REPLY = "No agent session is attached to this merge request.";

/**
 * What the resumed agent answers: the text the steward posts in the note's discussion, and the lasting instructions the
 * person gave about the MR ("keep X", "don't Y"), one line each, restated from what they said (empty when none).
 */
export const ChatResultSchema = z.object({
  reply: z.string(),
  decisions: z.array(z.string()).default([]),
});
export type ChatResult = z.infer<typeof ChatResultSchema>;

export const chatResultJsonSchema: Record<string, unknown> = z.toJSONSchema(ChatResultSchema, { target: "draft-07" });

/** Parse the brain's chat output. */
export const validateChatResult = (output: unknown): { ok: true; result: ChatResult } | { ok: false; error: string } => {
  const parsed = ChatResultSchema.safeParse(output);
  if (!parsed.success) return { ok: false, error: z.prettifyError(parsed.error) };
  if (parsed.data.reply.trim() === "") return { ok: false, error: "reply is empty" };
  return { ok: true, result: parsed.data };
};

/** What a chat job posts once its brain ran: stored before it is posted, so a retry never runs the brain again. */
export const StoredChatSchema = z.object({
  /** The note body without the steward's marker. */
  reply: z.string(),
  /** Why the run did not go as asked (the brain failed, its answer was unreadable); the job finishes with it as a warning. */
  warning: z.string().nullable(),
});
export type StoredChat = z.infer<typeof StoredChatSchema>;
