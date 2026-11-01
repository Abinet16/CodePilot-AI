import type { RepositoryChecks } from "@codepilot/contracts";

/**
 * The model never supplies a shell command. It may only request a command
 * profile by id; profiles are configured per repository by a human and
 * validated here before they are stored or executed.
 */

export interface CommandProfile {
  id: string;
  /** Executable name, resolved inside the sandbox image. Never a path. */
  executable: string;
  args: string[];
  timeoutMs: number;
}

export const ALLOWED_EXECUTABLES: ReadonlySet<string> = new Set(["npm", "pnpm", "yarn", "node", "tsc", "eslint", "jest", "vitest"]);

const MAX_TIMEOUT_MS = 15 * 60 * 1000;

/** Characters that only matter to a shell; args are passed via execFile, so these indicate intent to escape. */
const SHELL_METACHARACTERS = /[;&|`$<>(){}\n\r\\*?!~]/;

export class CommandPolicyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CommandPolicyError";
  }
}

export function validateCommandProfile(profile: CommandProfile): CommandProfile {
  if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(profile.id)) {
    throw new CommandPolicyError(`Invalid profile id: ${JSON.stringify(profile.id)}`);
  }
  if (!ALLOWED_EXECUTABLES.has(profile.executable)) {
    throw new CommandPolicyError(`Executable not allowed: ${JSON.stringify(profile.executable)}`);
  }
  if (profile.args.length > 32) throw new CommandPolicyError("Too many arguments");
  for (const arg of profile.args) {
    if (arg.length > 256 || SHELL_METACHARACTERS.test(arg) || arg.includes("\0")) {
      throw new CommandPolicyError(`Argument not allowed: ${JSON.stringify(arg)}`);
    }
  }
  if (!Number.isInteger(profile.timeoutMs) || profile.timeoutMs <= 0 || profile.timeoutMs > MAX_TIMEOUT_MS) {
    throw new CommandPolicyError(`Timeout must be between 1ms and ${MAX_TIMEOUT_MS}ms`);
  }
  return profile;
}

/** Looks up a profile the model requested by id. Unknown ids are rejected, not guessed. */
export function selectCommandProfile(profiles: readonly CommandProfile[], requestedId: string): CommandProfile {
  const match = profiles.find((p) => p.id === requestedId);
  if (!match) throw new CommandPolicyError(`Unknown command profile: ${JSON.stringify(requestedId)}`);
  return validateCommandProfile(match);
}

const PACKAGE_MANAGERS: ReadonlySet<string> = new Set(["npm", "pnpm", "yarn"]);
const INSTALL_SUBCOMMANDS: ReadonlySet<string> = new Set(["install", "ci"]);
/** npm, pnpm, and yarn 1 use --ignore-scripts; yarn 2+ uses --mode=skip-build. */
const SCRIPT_GUARDS = ["--ignore-scripts", "--mode=skip-build"];

/**
 * The install step is the only one that runs with the network on, so it is
 * restricted to a package manager's install command with lifecycle scripts
 * disabled: dependencies are fetched, but no dependency code runs.
 */
export function validateInstallProfile(profile: CommandProfile): CommandProfile {
  validateCommandProfile(profile);
  if (!PACKAGE_MANAGERS.has(profile.executable)) {
    throw new CommandPolicyError(`The install step must use npm, pnpm, or yarn, not ${JSON.stringify(profile.executable)}`);
  }
  if (!INSTALL_SUBCOMMANDS.has(profile.args[0] ?? "")) {
    throw new CommandPolicyError("The install step must start with install or ci");
  }
  if (!profile.args.some((a) => SCRIPT_GUARDS.includes(a))) {
    throw new CommandPolicyError("The install step must disable lifecycle scripts with --ignore-scripts (or --mode=skip-build for yarn 2+)");
  }
  return profile;
}

/** Validates a whole configuration before it is stored, and again before it runs. */
export function validateRepositoryChecks(config: RepositoryChecks): RepositoryChecks {
  if (config.install) validateInstallProfile(config.install);
  const ids = new Set<string>(config.install ? [config.install.id] : []);
  for (const check of config.checks) {
    validateCommandProfile(check);
    if (ids.has(check.id)) throw new CommandPolicyError(`Duplicate profile id: ${JSON.stringify(check.id)}`);
    ids.add(check.id);
  }
  return config;
}

/** The command as a person would type it, for display only. It is never passed to a shell. */
export function describeCommand(profile: Pick<CommandProfile, "executable" | "args">): string {
  return [profile.executable, ...profile.args].join(" ");
}
