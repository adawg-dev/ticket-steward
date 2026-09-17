import { toTemplateSummary } from "../../../src/tracker/linear/templates.js";

const body = "**Repro Steps**\nDo the thing\n\n**Expected**\nIt works\n\nSome *emphasis* line\n**Evidence**";

describe("toTemplateSummary", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("takes required fields from templateData form fields flagged required", () => {
    expect(
      toTemplateSummary({
        name: "Bugs",
        description: "Report a defect",
        content: body,
        templateData: {
          fields: [
            { label: "Repro Steps", required: true },
            { label: "Notes", required: false },
            { name: "Evidence", required: true },
          ],
        },
      }),
    ).toEqual({ name: "Bugs", description: "Report a defect", body, requiredFields: ["Repro Steps", "Evidence"] });
  });

  it("falls back to bold heading lines when templateData has no required fields", () => {
    expect(toTemplateSummary({ name: "Bugs", description: null, content: body, templateData: { title: "Bug: " } })).toEqual({
      name: "Bugs",
      description: "",
      body,
      requiredFields: ["Repro Steps", "Expected", "Evidence"],
    });
  });

  it("handles a template without content", () => {
    expect(toTemplateSummary({ name: "Empty", templateData: {} })).toEqual({
      name: "Empty",
      description: "",
      body: "",
      requiredFields: [],
    });
  });
});
