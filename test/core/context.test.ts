import { renderTemplatesMarkdown, renderTicketMarkdown } from "../../src/core/context.js";
import type { TicketBundle } from "../../src/tracker/types.js";

const bundle: TicketBundle = {
  id: "issue-1",
  identifier: "API-1",
  url: "https://linear.app/acme/issue/API-1",
  title: "Login fails",
  description: "Clicking login hangs.",
  team: { id: "team-1", key: "API", name: "API Team" },
  state: { name: "Triage", type: "triage" },
  labels: ["bug", "auth"],
  priority: 2,
  creator: { name: "Ada", isBot: false },
  createdAt: "2026-09-11T10:00:00.000Z",
  comments: [{ author: "Grace", body: "Reproduced on staging.", createdAt: "2026-09-11T11:00:00.000Z" }],
  attachments: [{ title: "Screen recording", url: "https://example.com/rec.mp4" }],
  appliedTemplate: "Bugs",
  templates: [
    {
      name: "Bugs",
      description: "Report a defect",
      body: "**Repro Steps**\n\n**Evidence**",
      requiredFields: ["Repro Steps", "Evidence"],
    },
  ],
};

describe("renderTicketMarkdown", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("renders the ticket with metadata, description, comments and attachments", () => {
    expect(renderTicketMarkdown(bundle)).toBe(
      [
        "# API-1: Login fails",
        "",
        "- URL: https://linear.app/acme/issue/API-1",
        "- Team: API Team (API)",
        "- State: Triage (triage)",
        "- Priority: 2",
        "- Labels: bug, auth",
        "- Creator: Ada",
        "- Created: 2026-09-11T10:00:00.000Z",
        "- Applied template: Bugs",
        "",
        "## Description",
        "",
        "Clicking login hangs.",
        "",
        "## Comments",
        "",
        "### Grace · 2026-09-11T11:00:00.000Z",
        "",
        "Reproduced on staging.",
        "",
        "## Attachments",
        "",
        "- [Screen recording](https://example.com/rec.mp4)",
      ].join("\n"),
    );
  });

  it("renders placeholders when there is no creator, comments or attachments", () => {
    const rendered = renderTicketMarkdown({
      ...bundle,
      creator: null,
      labels: [],
      comments: [],
      attachments: [],
      appliedTemplate: null,
    });
    expect(rendered).toContain("- Labels: none");
    expect(rendered).toContain("- Creator: unknown");
    expect(rendered).toContain("- Applied template: none");
    expect(rendered).toContain("## Comments\n\n_No comments._");
    expect(rendered).toContain("## Attachments\n\n_No attachments._");
  });
});

describe("renderTemplatesMarkdown", () => {
  it("renders each template with its required fields and body", () => {
    expect(renderTemplatesMarkdown(bundle)).toBe(
      [
        "## Bugs",
        "",
        "Report a defect",
        "",
        "Required fields: Repro Steps, Evidence",
        "",
        "```markdown",
        "**Repro Steps**",
        "",
        "**Evidence**",
        "```",
      ].join("\n"),
    );
  });

  it("renders a placeholder when there are no templates", () => {
    expect(renderTemplatesMarkdown({ ...bundle, templates: [] })).toBe("_No templates configured._");
  });
});
