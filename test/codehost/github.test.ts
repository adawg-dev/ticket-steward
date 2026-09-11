import { GitHubCodeHost } from "../../src/codehost/github.js";

const listPullRequestsAssociatedWithCommitMock = vi.fn();
const getCommitMock = vi.fn();

const host = () =>
  new GitHubCodeHost({
    owner: "concentrateai",
    repo: "kickoff",
    client: {
      listPullRequestsAssociatedWithCommit: listPullRequestsAssociatedWithCommitMock,
      getCommit: getCommitMock,
    },
  });

beforeEach(() => {
  vi.restoreAllMocks();
  listPullRequestsAssociatedWithCommitMock.mockReset();
  getCommitMock.mockReset();
});

describe("GitHubCodeHost", () => {
  it("builds a permalink with a line", () => {
    expect(host().permalink("src/a.ts", "abc123", 12)).toBe(
      "https://github.com/concentrateai/kickoff/blob/abc123/src/a.ts#L12",
    );
  });

  it("builds a permalink without a line", () => {
    expect(host().permalink("src/a.ts", "abc123")).toBe(
      "https://github.com/concentrateai/kickoff/blob/abc123/src/a.ts",
    );
  });

  it("maps pull requests and dedupes commits that share one", async () => {
    const pr = {
      number: 7,
      title: "Fix login",
      html_url: "https://github.com/concentrateai/kickoff/pull/7",
      user: { login: "ada" },
      created_at: "2026-09-01T10:00:00Z",
      merged_at: "2026-09-02T10:00:00Z",
    };
    listPullRequestsAssociatedWithCommitMock
      .mockResolvedValueOnce({ data: [pr] })
      .mockResolvedValueOnce({ data: [pr] });

    const changes = await host().changesForCommits(["aaa", "bbb"]);

    expect(changes).toEqual([
      {
        kind: "merge_request",
        id: "7",
        title: "Fix login",
        url: "https://github.com/concentrateai/kickoff/pull/7",
        author: "ada",
        at: "2026-09-02T10:00:00Z",
        shas: ["aaa", "bbb"],
      },
    ]);
    expect(listPullRequestsAssociatedWithCommitMock).toHaveBeenNthCalledWith(1, {
      owner: "concentrateai",
      repo: "kickoff",
      commit_sha: "aaa",
    });
    expect(listPullRequestsAssociatedWithCommitMock).toHaveBeenNthCalledWith(2, {
      owner: "concentrateai",
      repo: "kickoff",
      commit_sha: "bbb",
    });
  });

  it("turns a commit with no pull request into a commit ref", async () => {
    listPullRequestsAssociatedWithCommitMock.mockResolvedValueOnce({ data: [] });
    getCommitMock.mockResolvedValueOnce({
      data: {
        sha: "ccc",
        html_url: "https://github.com/concentrateai/kickoff/commit/ccc",
        commit: {
          message: "Direct push\n\nMore detail",
          author: { name: "Bob", date: "2026-09-03T10:00:00Z" },
        },
      },
    });

    const changes = await host().changesForCommits(["ccc"]);

    expect(changes).toEqual([
      {
        kind: "commit",
        id: "ccc",
        title: "Direct push",
        url: "https://github.com/concentrateai/kickoff/commit/ccc",
        author: "Bob",
        at: "2026-09-03T10:00:00Z",
        shas: ["ccc"],
      },
    ]);
    expect(getCommitMock).toHaveBeenCalledWith({ owner: "concentrateai", repo: "kickoff", ref: "ccc" });
  });
});
