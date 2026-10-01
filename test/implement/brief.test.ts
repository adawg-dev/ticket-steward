import { BRIEF_BEGIN, BRIEF_END } from "../../src/core/render.js";
import { extractAgentBrief } from "../../src/implement/brief.js";

describe("extractAgentBrief", () => {
  it("returns the text between the markers", () => {
    expect(extractAgentBrief(`Body\n### Agent brief\n${BRIEF_BEGIN}\nGoal: fix.\n${BRIEF_END}\nmore`)).toBe("Goal: fix.");
  });

  it("returns null without markers or with an empty brief", () => {
    expect(extractAgentBrief("Body only")).toBeNull();
    expect(extractAgentBrief(`${BRIEF_BEGIN}\n  \n${BRIEF_END}`)).toBeNull();
  });
});
