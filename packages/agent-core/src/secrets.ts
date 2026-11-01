/**
 * Token shapes masked wherever untrusted or external text is stored or shown:
 * audit metadata, check output, anything that might echo an environment.
 */
const SECRET_PATTERNS: readonly RegExp[] = [
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g,
  /\bsk-ant-[A-Za-z0-9_-]{20,}\b/g,
  /\bnpm_[A-Za-z0-9]{30,}\b/g,
  /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  /\b(Bearer|Basic)\s+[A-Za-z0-9+/._~-]{16,}={0,2}/g,
];

export function maskSecrets(text: string): string {
  return SECRET_PATTERNS.reduce((s, re) => s.replace(re, "[redacted]"), text);
}
