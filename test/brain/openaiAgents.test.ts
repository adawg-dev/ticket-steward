import { modelSettingsFor } from "../../src/brain/openaiAgents.js";

describe("modelSettingsFor", () => {
  it("sends the configured reasoning effort", () => {
    expect(modelSettingsFor({ reasoningEffort: "high" })).toEqual({ reasoning: { effort: "high" } });
  });

  it("leaves the SDK's per-model default alone when none is configured", () => {
    expect(modelSettingsFor({})).toEqual({});
  });
});
