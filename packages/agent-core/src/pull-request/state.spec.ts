import { nextPullRequestState, statusFromGitHub } from "./state";

const base = { state: "open" as const, draft: true, merged_at: null, closed_at: null, updated_at: "2026-11-02T10:00:00Z", head: { sha: "a".repeat(40) } };
const stored = { status: "DRAFT" as const, headSha: "a".repeat(40), githubUpdatedAt: new Date("2026-11-02T10:00:00Z") };

describe("statusFromGitHub", () => {
  it("maps GitHub's state, draft flag, and merge time", () => {
    expect(statusFromGitHub(base)).toBe("DRAFT");
    expect(statusFromGitHub({ ...base, draft: false })).toBe("OPEN");
    expect(statusFromGitHub({ ...base, state: "closed" })).toBe("CLOSED");
    expect(statusFromGitHub({ ...base, state: "closed", merged_at: "2026-11-02T11:00:00Z" })).toBe("MERGED");
  });
});

describe("nextPullRequestState", () => {
  it("applies a newer report and names the event", () => {
    const update = nextPullRequestState(stored, { ...base, draft: false, updated_at: "2026-11-02T10:05:00Z" });
    expect(update).toMatchObject({ status: "OPEN", event: "pull_request_ready_for_review" });
  });

  it("records merges with their time", () => {
    const update = nextPullRequestState(stored, { ...base, state: "closed", merged_at: "2026-11-02T11:00:00Z", closed_at: "2026-11-02T11:00:00Z", updated_at: "2026-11-02T11:00:00Z" });
    expect(update).toMatchObject({ status: "MERGED", event: "pull_request_merged", mergedAt: new Date("2026-11-02T11:00:00Z") });
  });

  it("ignores a report older than the stored state", () => {
    expect(nextPullRequestState({ ...stored, status: "CLOSED" }, { ...base, updated_at: "2026-11-02T09:00:00Z" })).toBeNull();
  });

  it("refreshes the head without an event when nothing else changed", () => {
    const update = nextPullRequestState(stored, { ...base, head: { sha: "b".repeat(40) }, updated_at: "2026-11-02T10:01:00Z" });
    expect(update).toMatchObject({ status: "DRAFT", headSha: "b".repeat(40), event: null });
  });

  it("notices a reopened pull request and never un-merges one", () => {
    expect(nextPullRequestState({ ...stored, status: "CLOSED" }, { ...base, updated_at: "2026-11-02T12:00:00Z" })?.event).toBe("pull_request_reopened");
    expect(nextPullRequestState({ ...stored, status: "MERGED" }, { ...base, updated_at: "2026-11-02T12:00:00Z" })?.status).toBe("MERGED");
  });
});
