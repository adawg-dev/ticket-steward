const ZERO_WIDTH_SPACE = "​";
const WORD_JOINER = "⁠";

/** A quick action: the line's first non-space characters are `/` and a letter. */
const QUICK_ACTION = /^(\s*)\/(?=\p{L})/u;
/** A mention: `@` and a word character, not after a word character (an email address). */
const MENTION = /(?<![\p{L}\p{N}_])@(?=[\p{L}\p{N}_])/gu;
/** An http(s) URL with a host running up to the end of the text before a mention: GitLab links it, so it names no one. */
const IN_URL = /https?:\/\/[^\s/]+\/\S*$/;

/**
 * Text the steward posts to GitLab as its own account, made inert: GitLab runs quick actions (`/merge`, `/approve`) its
 * author writes and notifies whoever an `@name` names. On every line, fenced code included (fence parsing that differs
 * from GitLab's is a bypass), a zero-width space goes before a line's leading `/` and a word joiner after a mention's
 * `@`, except an `@` inside an http(s) URL path; the text reads the same.
 */
export const neutralizeGitLab = (text: string): string =>
  text
    .split("\n")
    .map((line) =>
      line
        .replace(QUICK_ACTION, `$1${ZERO_WIDTH_SPACE}/`)
        .replace(MENTION, (at, offset: number) => (IN_URL.test(line.slice(0, offset)) ? at : `@${WORD_JOINER}`)),
    )
    .join("\n");
