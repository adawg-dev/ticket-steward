import {
  buildComment,
  buildEnrichmentSection,
  linkify,
  replaceSection,
  truncate,
} from "../../src/core/render.js";
import { STEWARD_BEGIN, STEWARD_END } from "../../src/core/intake.js";
import type { BrainResult } from "../../src/core/result.js";
import type { SectionMeta } from "../../src/core/render.js";

const result: BrainResult = {
  template: { matched: "Bugs", conforms: false, missing: ["Repro Steps", "Evidence"] },
  summary: "The handler drops the status code.",
  enrichment: "Look at `src/handler.ts:12` and `src/handler.ts`.",
  attachments: [],
  confidence: "high",
};

const permalink: SectionMeta["permalink"] = (path, line) =>
  `https://gitlab.example.com/blob/1a2b3c4d5e6f/${path}${line === undefined ? "" : `#L${line}`}`;

const meta: SectionMeta = {
  now: new Date("2026-09-11T14:02:33.000Z"),
  sha: "1a2b3c4d5e6f7890",
  branch: "dev",
  jobId: 42,
  permalink,
};

describe("buildEnrichmentSection", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("renders a deterministic section with header, template line, linkified body and images", () => {
    const section = buildEnrichmentSection(
      result,
      [{ url: "https://uploads.linear.app/shot.png", caption: "Login page" }],
      ["Attachment `../etc/passwd` was dropped."],
      meta,
    );
    expect(section).toBe(
      [
        STEWARD_BEGIN,
        "## Enrichment",
        "_Ticket Steward · 2026-09-11 14:02 UTC · dev@1a2b3c4 · confidence: high · job 42_",
        "",
        "**Template:** Bugs — missing: Repro Steps, Evidence",
        "",
        "Look at [src/handler.ts:12](https://gitlab.example.com/blob/1a2b3c4d5e6f/src/handler.ts#L12) and [src/handler.ts](https://gitlab.example.com/blob/1a2b3c4d5e6f/src/handler.ts).",
        "",
        "![Login page](https://uploads.linear.app/shot.png)",
        "",
        "_Note: Attachment `../etc/passwd` was dropped._",
        STEWARD_END,
      ].join("\n"),
    );
  });

  it("renders the same string for the same inputs", () => {
    expect(buildEnrichmentSection(result, [], [], meta)).toBe(buildEnrichmentSection(result, [], [], meta));
  });

  it("describes a conforming template and an unmatched template", () => {
    const conforming = buildEnrichmentSection(
      { ...result, template: { matched: "Bugs", conforms: true, missing: [] } },
      [],
      [],
      meta,
    );
    expect(conforming).toContain("**Template:** Bugs — conforms");
    const unmatched = buildEnrichmentSection(
      { ...result, template: { matched: null, conforms: false, missing: [] } },
      [],
      [],
      meta,
    );
    expect(unmatched).toContain("**Template:** none matched");
  });
});

describe("replaceSection", () => {
  it("replaces an existing section between the markers", () => {
    const description = `Intro\n\n${STEWARD_BEGIN}\nold\n${STEWARD_END}\n\nOutro`;
    const section = `${STEWARD_BEGIN}\nnew\n${STEWARD_END}`;
    expect(replaceSection(description, section)).toBe(`Intro\n\n${section}\n\nOutro`);
  });

  it("appends after two newlines when no section exists", () => {
    const section = `${STEWARD_BEGIN}\nnew\n${STEWARD_END}`;
    expect(replaceSection("Intro", section)).toBe(`Intro\n\n${section}`);
  });

  it("returns only the section for an empty description", () => {
    const section = `${STEWARD_BEGIN}\nnew\n${STEWARD_END}`;
    expect(replaceSection("", section)).toBe(section);
  });
});

describe("linkify", () => {
  it("links backticked paths with and without a line number", () => {
    expect(linkify("See `a/b.ts:7` and `a/b.ts`.", permalink)).toBe(
      "See [a/b.ts:7](https://gitlab.example.com/blob/1a2b3c4d5e6f/a/b.ts#L7) and [a/b.ts](https://gitlab.example.com/blob/1a2b3c4d5e6f/a/b.ts).",
    );
  });

  it("leaves fenced code blocks untouched", () => {
    const markdown = "Before `a/b.ts:1`\n\n```ts\nimport x from `a/b.ts:2`;\n```\n\nAfter `a/b.ts:3`";
    expect(linkify(markdown, permalink)).toBe(
      "Before [a/b.ts:1](https://gitlab.example.com/blob/1a2b3c4d5e6f/a/b.ts#L1)\n\n```ts\nimport x from `a/b.ts:2`;\n```\n\nAfter [a/b.ts:3](https://gitlab.example.com/blob/1a2b3c4d5e6f/a/b.ts#L3)",
    );
  });

  it("leaves URLs and non-path code untouched", () => {
    const markdown = "Open `https://example.com/a/b.ts` then run `pnpm test` and check `e.g.` `v1.2`";
    expect(linkify(markdown, permalink)).toBe(markdown);
  });
});

describe("buildComment", () => {
  it("renders the comment with job id, confidence and summary", () => {
    expect(buildComment(result, 42)).toBe(
      "Enrichment added (job 42, confidence high). The handler drops the status code.\n@mention or assign me to re-run.",
    );
  });

  it("truncates the summary to 600 characters", () => {
    const comment = buildComment({ ...result, summary: "s".repeat(700) }, 42);
    expect(comment).toBe(
      `Enrichment added (job 42, confidence high). ${"s".repeat(599)}…\n@mention or assign me to re-run.`,
    );
  });
});

describe("truncate", () => {
  it("returns short strings unchanged", () => {
    expect(truncate("abc", 3)).toBe("abc");
  });

  it("cuts long strings to max length ending in an ellipsis", () => {
    expect(truncate("abcdef", 4)).toBe("abc…");
  });
});
