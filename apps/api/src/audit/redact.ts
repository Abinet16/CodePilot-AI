const SENSITIVE_KEY = /(token|secret|password|authorization|cookie|private_?key|credential|^code$)/i;
const TOKEN_PATTERNS = [/\bgh[pousr]_[A-Za-z0-9]{20,}\b/g, /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g, /\bsk-ant-[A-Za-z0-9_-]{20,}\b/g];
const MAX_STRING = 2_000;
const MAX_ARRAY = 100;
const MAX_DEPTH = 8;

/**
 * Makes arbitrary metadata safe to persist in audit logs and task events:
 * removes sensitive keys, masks token-shaped strings, bounds size, and
 * converts bigint (not representable in JSON) to string.
 */
export function redact(value: unknown, depth = 0): unknown {
  if (depth > MAX_DEPTH) return "[truncated]";
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "string") {
    const masked = TOKEN_PATTERNS.reduce((s, re) => s.replace(re, "[redacted]"), value);
    return masked.length > MAX_STRING ? `${masked.slice(0, MAX_STRING)}…[truncated]` : masked;
  }
  if (Array.isArray(value)) return value.slice(0, MAX_ARRAY).map((v) => redact(v, depth + 1));
  if (value instanceof Date) return value.toISOString();
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, SENSITIVE_KEY.test(k) ? "[redacted]" : redact(v, depth + 1)]),
    );
  }
  return value;
}
