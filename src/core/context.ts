import type { TicketBundle } from "../tracker/types.js";

const listOrNone = (items: string[]): string => (items.length === 0 ? "none" : items.join(", "));

const renderComments = (comments: TicketBundle["comments"]): string =>
  comments.length === 0
    ? "_No comments._"
    : comments.map(({ author, createdAt, body }) => `### ${author} · ${createdAt}\n\n${body}`).join("\n\n");

const renderAttachments = (attachments: TicketBundle["attachments"]): string =>
  attachments.length === 0
    ? "_No attachments._"
    : attachments.map(({ title, url }) => `- [${title}](${url})`).join("\n");

export const renderTicketMarkdown = (bundle: TicketBundle): string =>
  [
    `# ${bundle.identifier}: ${bundle.title}`,
    "",
    `- URL: ${bundle.url}`,
    `- Team: ${bundle.team.name} (${bundle.team.key})`,
    `- State: ${bundle.state.name} (${bundle.state.type})`,
    `- Priority: ${bundle.priority}`,
    `- Labels: ${listOrNone(bundle.labels)}`,
    `- Creator: ${bundle.creator?.name ?? "unknown"}`,
    `- Created: ${bundle.createdAt}`,
    `- Applied template: ${bundle.appliedTemplate ?? "none"}`,
    "",
    "## Description",
    "",
    bundle.description,
    "",
    "## Comments",
    "",
    renderComments(bundle.comments),
    "",
    "## Attachments",
    "",
    renderAttachments(bundle.attachments),
  ].join("\n");

export const renderTemplatesMarkdown = (bundle: TicketBundle): string =>
  bundle.templates.length === 0
    ? "_No templates configured._"
    : bundle.templates
        .map(({ name, description, requiredFields, body }) =>
          [
            `## ${name}`,
            "",
            description,
            "",
            `Required fields: ${listOrNone(requiredFields)}`,
            "",
            "```markdown",
            body,
            "```",
          ].join("\n"),
        )
        .join("\n\n");
