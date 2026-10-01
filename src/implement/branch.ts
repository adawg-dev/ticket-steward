const SLUG_MAX = 40;
const FALLBACK_SLUG = "change";

const escapeRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export const slugify = (title: string): string =>
  title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, SLUG_MAX)
    .replace(/-+$/, "");

export const branchName = (type: string, identifier: string, title: string): string => {
  const slug = slugify(title);
  return `${type}/${identifier}-${slug === "" ? FALLBACK_SLUG : slug}`;
};

/** The only refs the steward will push for this ticket. */
export const branchRefPattern = (types: string[], identifier: string): RegExp =>
  new RegExp(`^refs/heads/(?:${types.map(escapeRegExp).join("|")})/${escapeRegExp(identifier)}-[a-z0-9-]+$`);

/** True when a remote branch already belongs to this ticket, whatever its (possibly nested) type prefix or casing; mirrors git's glob where `*` crosses slashes. */
export const carriesTicket = (ref: string, identifier: string): boolean =>
  new RegExp(`^refs/heads/.+/${escapeRegExp(identifier)}-`, "i").test(ref);
