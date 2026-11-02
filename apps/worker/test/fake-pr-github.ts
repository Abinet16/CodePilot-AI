import { execFileSync } from "node:child_process";
import type { GitHubPullRequest, GitHubRepository, NewPullRequest, PullRequestGitHub } from "@codepilot/github";
import { GitHubApiError } from "@codepilot/github";

/**
 * GitHub's REST side, faked in memory, in front of a real local git remote:
 * branch lookups and deletions read and change the fixture repository the
 * worker actually pushes to.
 */
export class FakePullRequestGitHub implements PullRequestGitHub {
  readonly pulls: Array<GitHubPullRequest & { title: string; body: string; draft: boolean }> = [];
  readonly calls: string[] = [];
  /** Status codes to fail the next createPullRequest calls with, in order. */
  failCreate: number[] = [];

  constructor(private readonly remoteDir: string) {}

  async getInstallationToken(): Promise<string> {
    return "ghs_fake";
  }

  async getRepository(): Promise<GitHubRepository> {
    throw new Error("not used");
  }

  async getBranchHeadSha(installationId: bigint, owner: string, name: string, branch: string): Promise<string> {
    const sha = await this.findBranchHeadSha(installationId, owner, name, branch);
    if (!sha) throw new GitHubApiError(404, "GET branch");
    return sha;
  }

  async findBranchHeadSha(_i: bigint, _o: string, _n: string, branch: string): Promise<string | null> {
    this.calls.push(`findBranch ${branch}`);
    try {
      return execFileSync("git", ["-C", this.remoteDir, "rev-parse", "--verify", "--quiet", `refs/heads/${branch}`]).toString().trim();
    } catch {
      return null;
    }
  }

  async deleteBranch(_i: bigint, _o: string, _n: string, branch: string): Promise<void> {
    this.calls.push(`deleteBranch ${branch}`);
    execFileSync("git", ["-C", this.remoteDir, "update-ref", "-d", `refs/heads/${branch}`]);
  }

  async findPullRequestByHead(_i: bigint, _o: string, _n: string, branch: string): Promise<GitHubPullRequest | null> {
    this.calls.push(`findPull ${branch}`);
    return [...this.pulls].reverse().find((p) => p.head.ref === branch) ?? null;
  }

  async createPullRequest(_i: bigint, owner: string, name: string, pr: NewPullRequest): Promise<GitHubPullRequest> {
    this.calls.push(`createPull ${pr.head}`);
    const failure = this.failCreate.shift();
    if (failure) throw new GitHubApiError(failure, "POST pulls");
    const sha = (await this.findBranchHeadSha(0n, owner, name, pr.head))!;
    const now = new Date().toISOString();
    const created = {
      number: 100 + this.pulls.length,
      html_url: `https://github.com/${owner}/${name}/pull/${100 + this.pulls.length}`,
      state: "open" as const,
      draft: pr.draft,
      merged_at: null,
      closed_at: null,
      created_at: now,
      updated_at: now,
      head: { ref: pr.head, sha },
      base: { ref: pr.base },
      title: pr.title,
      body: pr.body,
    };
    this.pulls.push(created);
    return created;
  }

  async getPullRequest(_i: bigint, _o: string, _n: string, number: number): Promise<GitHubPullRequest> {
    this.calls.push(`getPull ${number}`);
    const pr = this.pulls.find((p) => p.number === number);
    if (!pr) throw new GitHubApiError(404, "GET pull");
    return pr;
  }
}
