import { OpenPullRequestRequestSchema } from "./pull-request";

describe("OpenPullRequestRequestSchema", () => {
  it("names the patch version and rejects anything else", () => {
    expect(OpenPullRequestRequestSchema.safeParse({ patchVersion: 2 }).success).toBe(true);
    expect(OpenPullRequestRequestSchema.safeParse({}).success).toBe(false);
    expect(OpenPullRequestRequestSchema.safeParse({ patchVersion: 0 }).success).toBe(false);
    expect(OpenPullRequestRequestSchema.safeParse({ patchVersion: 1, draft: false }).success).toBe(false);
  });
});
