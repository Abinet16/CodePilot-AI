import type { CheckKind, CheckProfile, ProjectProfile, RepositoryChecks } from "@codepilot/contracts";
import type { CommandProfile } from "../command-policy";
import { validateRepositoryChecks } from "../command-policy";

const INSTALL_ARGS: Record<string, string[]> = {
  npm: ["ci", "--ignore-scripts"],
  pnpm: ["install", "--frozen-lockfile", "--ignore-scripts"],
  yarn: ["install", "--frozen-lockfile", "--ignore-scripts"],
};

/** Script names to look for, per check kind, in the order a reviewer would want them run. */
const SCRIPT_CANDIDATES: ReadonlyArray<[CheckKind, string[]]> = [
  ["typecheck", ["typecheck", "type-check", "tsc"]],
  ["lint", ["lint"]],
  ["test", ["test", "test:unit"]],
];

const SCRIPT_NAME = /^[a-z0-9][a-z0-9:_-]{0,62}$/i;

/**
 * Proposes checks from the package.json scripts found during analysis. Only
 * script names are used (as `<pm> run <name>`), never script bodies, and the
 * result is a suggestion a maintainer must save before anything runs.
 */
export function suggestChecks(profile: ProjectProfile): RepositoryChecks | null {
  const pm = profile.packageManager;
  if (pm !== "npm" && pm !== "pnpm" && pm !== "yarn") return null;

  const install: CommandProfile = { id: "install", executable: pm, args: INSTALL_ARGS[pm]!, timeoutMs: 10 * 60_000 };
  const checks: CheckProfile[] = [];
  for (const [kind, names] of SCRIPT_CANDIDATES) {
    const script = names.find((n) => n in profile.scripts && SCRIPT_NAME.test(n));
    if (!script) continue;
    checks.push({ id: kind, kind, executable: pm, args: ["run", script], timeoutMs: (kind === "test" ? 10 : 5) * 60_000 });
  }
  if (checks.length === 0) return null;
  return validateRepositoryChecks({ install, checks });
}
