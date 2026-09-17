import { GitLabCodeHost } from "../../src/codehost/gitlab.js";

const host = () =>
  new GitLabCodeHost({
    baseUrl: "https://gitlab.com",
    project: "concentrateai/kickoff",
    client: { allMergeRequests: allMergeRequestsMock, show: showMock },
  });

const allMergeRequestsMock = vi.fn();
const showMock = vi.fn();

beforeEach(() => {
  vi.restoreAllMocks();
  allMergeRequestsMock.mockReset();
  showMock.mockReset();
});

describe("GitLabCodeHost", () => {
  it("builds a permalink with a line", () => {
    expect(host().permalink("src/a.ts", "abc123", 12)).toBe(
      "https://gitlab.com/concentrateai/kickoff/-/blob/abc123/src/a.ts#L12",
    );
  });

  it("builds a permalink without a line", () => {
    expect(host().permalink("src/a.ts", "abc123")).toBe(
      "https://gitlab.com/concentrateai/kickoff/-/blob/abc123/src/a.ts",
    );
  });

  it("maps merge requests and dedupes commits that share one", async () => {
    const mr = {
      iid: 7,
      title: "Fix login",
      web_url: "https://gitlab.com/concentrateai/kickoff/-/merge_requests/7",
      author: { name: "Ada" },
      created_at: "2026-09-01T10:00:00Z",
      merged_at: "2026-09-02T10:00:00Z",
    };
    allMergeRequestsMock.mockResolvedValueOnce([mr]).mockResolvedValueOnce([mr]);

    const changes = await host().changesForCommits(["aaa", "bbb"]);

    expect(changes).toEqual([
      {
        kind: "merge_request",
        id: "7",
        title: "Fix login",
        url: "https://gitlab.com/concentrateai/kickoff/-/merge_requests/7",
        author: "Ada",
        at: "2026-09-02T10:00:00Z",
        shas: ["aaa", "bbb"],
      },
    ]);
    expect(allMergeRequestsMock).toHaveBeenNthCalledWith(1, "concentrateai/kickoff", "aaa");
    expect(allMergeRequestsMock).toHaveBeenNthCalledWith(2, "concentrateai/kickoff", "bbb");
  });

  it("turns a commit with no merge request into a commit ref", async () => {
    allMergeRequestsMock.mockResolvedValueOnce([]);
    showMock.mockResolvedValueOnce({
      id: "ccc",
      title: "Direct push",
      author_name: "Bob",
      created_at: "2026-09-03T10:00:00Z",
      web_url: "https://gitlab.com/concentrateai/kickoff/-/commit/ccc",
    });

    const changes = await host().changesForCommits(["ccc"]);

    expect(changes).toEqual([
      {
        kind: "commit",
        id: "ccc",
        title: "Direct push",
        url: "https://gitlab.com/concentrateai/kickoff/-/commit/ccc",
        author: "Bob",
        at: "2026-09-03T10:00:00Z",
        shas: ["ccc"],
      },
    ]);
    expect(showMock).toHaveBeenCalledWith("concentrateai/kickoff", "ccc");
  });
});
