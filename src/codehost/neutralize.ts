const ZERO_WIDTH_SPACE = "​";
const WORD_JOINER = "⁠";

/** A quick action: a line's first non-space characters are `/` and a letter (`^` also matches after a lone `\r`). */
const QUICK_ACTION = /^(\s*)\/(?=\p{L})/gmu;
/** A mention: `@` and a word character, not after an ASCII word character (GitLab's `(?<!\w)`, so not an email address). */
const MENTION = /(?<![A-Za-z0-9_])@(?=[\p{L}\p{N}_])/gu;

/**
 * Text the steward posts to GitLab as its own account, made inert: GitLab runs quick actions (`/merge`, `/approve`) its
 * author writes and notifies whoever an `@name` names. Everywhere, fenced code and URLs included (any parsing that differs
 * from GitLab's is a bypass), a zero-width space goes before a line's leading `/` and a word joiner after a mention's `@`;
 * the text reads the same, though a URL with `/@name` in its path no longer links whole.
 */
export const neutralizeGitLab = (text: string): string =>
  text.replace(QUICK_ACTION, `$1${ZERO_WIDTH_SPACE}/`).replace(MENTION, `@${WORD_JOINER}`);
