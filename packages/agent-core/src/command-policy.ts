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
