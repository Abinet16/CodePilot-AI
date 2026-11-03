/** Display helpers shared by the dashboard pages. Pure, so they render the same on the server and in tests. */

export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "–";
  if (ms < 1_000) return `${Math.round(ms)}ms`;
  const seconds = Math.round(ms / 1_000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return seconds % 60 ? `${minutes}m ${seconds % 60}s` : `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  return minutes % 60 ? `${hours}h ${minutes % 60}m` : `${hours}h`;
}

const UNITS: Array<[Intl.RelativeTimeFormatUnit, number]> = [
  ["day", 86_400_000],
  ["hour", 3_600_000],
  ["minute", 60_000],
];

/** "3 minutes ago", "yesterday"; "just now" under a minute. */
export function relativeTime(iso: string, now: Date = new Date()): string {
  const diff = new Date(iso).getTime() - now.getTime();
  if (Number.isNaN(diff)) return "–";
  if (Math.abs(diff) < 60_000) return "just now";
  const format = new Intl.RelativeTimeFormat("en", { numeric: "auto" });
  for (const [unit, size] of UNITS) {
    if (Math.abs(diff) >= size) return format.format(Math.round(diff / size), unit);
  }
  return "just now";
}

/** 950 → "950", 12_345 → "12.3k", 2_500_000 → "2.5M". */
export function formatTokens(n: number): string {
  if (n < 1_000) return String(n);
  if (n < 1_000_000) return `${(n / 1_000).toFixed(n < 10_000 ? 1 : 0).replace(/\.0$/, "")}k`;
  return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
}

/** Dollars, with enough precision that small model calls do not all read "$0.00". */
export function formatUsd(n: number): string {
  if (n === 0) return "$0";
  if (n < 0.01) return `$${n.toFixed(4)}`;
  return `$${n.toFixed(2)}`;
}

export function shortSha(sha: string | null | undefined): string {
  return sha ? sha.slice(0, 12) : "–";
}

/** "AWAITING_PLAN_APPROVAL" → "awaiting plan approval". */
export function humanize(value: string): string {
  return value.toLowerCase().replace(/_/g, " ");
}
