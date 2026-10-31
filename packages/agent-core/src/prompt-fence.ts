/**
 * Fencing for untrusted text in prompts. Each request uses a random nonce in
 * the tag names, so repository content, issue text, or a reviewer note cannot
 * forge the end of its own block and pose as instructions.
 */
export function assertNonce(nonce: string): void {
  if (!/^[a-z0-9]{8,}$/.test(nonce)) throw new Error("nonce must be at least 8 lowercase alphanumeric characters");
}

export function untrusted(nonce: string, label: string, body: string): string {
  return `<untrusted-${nonce} source="${label}">\n${body}\n</untrusted-${nonce}>`;
}
