const ZERO_WIDTH_SPACE = "​";
const WORD_JOINER = "⁠";

/** A fence line: up to any indent, three or more backticks or tildes. */
const FENCE = /^\s*(`{3,}|~{3,})/;
/** A quick action: the line's first non-space characters are `/` and a letter. */
const QUICK_ACTION = /^(\s*)\/(?=\p{L})/u;
/** A mention: `@` and a word character, not after a word character or `/` (an email address, a URL path). */
const MENTION = /(?<![\p{L}\p{N}_/])@(?=[\p{L}\p{N}_])/gu;

const closes = (line: string, open: string): boolean => {
  const fence = line.trim();
  return fence.length >= open.length && fence === (open[0] ?? "").repeat(fence.length);
};

/**
 * Text the steward posts to GitLab as its own account, made inert: GitLab runs quick actions (`/merge`, `/approve`) its
 * author writes and notifies whoever an `@name` names. Outside fenced code blocks, a zero-width space goes before a
 * line's leading `/` and a word joiner after a mention's `@`; the text reads the same.
 */
export const neutralizeGitLab = (text: string): string => {
  let fence: string | null = null;
  return text
    .split("\n")
    .map((line) => {
      if (fence !== null) {
        if (closes(line, fence)) fence = null;
        return line;
      }
      const open = FENCE.exec(line);
      if (open?.[1] !== undefined) {
        fence = open[1];
        return line;
      }
      return line.replace(QUICK_ACTION, `$1${ZERO_WIDTH_SPACE}/`).replace(MENTION, `@${WORD_JOINER}`);
    })
    .join("\n");
};
