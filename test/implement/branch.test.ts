import { branchName, branchRefPattern, carriesTicket, slugify } from "../../src/implement/branch.js";

describe("branch naming", () => {
  it("slugifies a title", () => {
    expect(slugify("Routing settings: UI & API (v2)!")).toBe("routing-settings-ui-api-v2");
  });

  it("cuts the slug to 40 characters without a trailing hyphen", () => {
    const slug = slugify("a".repeat(39) + " bcdef");
    expect(slug.length).toBeLessThanOrEqual(40);
    expect(slug.endsWith("-")).toBe(false);
  });

  it("falls back to change when nothing survives", () => {
    expect(branchName("fix", "USRAPP-101", "🔥🔥")).toBe("fix/USRAPP-101-change");
  });

  it("keeps the identifier casing", () => {
    expect(branchName("chore", "API-101", "Bump pg")).toBe("chore/API-101-bump-pg");
  });

  it("matches only allowed types for this ticket", () => {
    const pattern = branchRefPattern(["feature", "fix"], "API-101");
    expect(pattern.test("refs/heads/fix/API-101-bump-pg")).toBe(true);
    expect(pattern.test("refs/heads/fix/API-101-change")).toBe(true);
    expect(pattern.test("refs/heads/hotfix/API-101-bump")).toBe(false);
    expect(pattern.test("refs/heads/fix/API-102-bump")).toBe(false);
    expect(pattern.test("refs/heads/dev")).toBe(false);
    expect(pattern.test("refs/heads/fix/API-101-Bump")).toBe(false);
  });

  it("detects any branch that carries the ticket, whatever its type", () => {
    expect(carriesTicket("refs/heads/feature/API-101-old-attempt", "API-101")).toBe(true);
    expect(carriesTicket("refs/heads/user/feature/API-101-x", "API-101")).toBe(true);
    expect(carriesTicket("refs/heads/feature/api-101-old-attempt", "API-101")).toBe(true);
    expect(carriesTicket("refs/heads/feature/API-1010-other", "API-101")).toBe(false);
    expect(carriesTicket("refs/heads/dev", "API-101")).toBe(false);
  });
});
