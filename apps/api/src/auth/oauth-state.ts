export interface OAuthState {
  state: string;
  returnTo: string;
}

/**
 * Only same-origin relative paths are allowed after login, preventing open
 * redirects such as `//evil.example` or `/\evil.example`.
 */
export function sanitizeReturnTo(value: unknown): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 512) return "/";
  if (!value.startsWith("/") || value.startsWith("//")) return "/";
  // Control characters and backslashes can be normalized by browsers into a host.
  // eslint-disable-next-line no-control-regex -- matching control characters is the point
  if (/[\u0000-\u001f\u007f\\]/.test(value)) return "/";
  return value;
}

export function encodeOAuthState(value: OAuthState): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

export function decodeOAuthState(cookie: string | undefined): OAuthState | null {
  if (!cookie) return null;
  try {
    const parsed: unknown = JSON.parse(Buffer.from(cookie, "base64url").toString("utf8"));
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      typeof (parsed as OAuthState).state === "string" &&
      typeof (parsed as OAuthState).returnTo === "string"
    ) {
      const { state, returnTo } = parsed as OAuthState;
      return { state, returnTo: sanitizeReturnTo(returnTo) };
    }
  } catch {
    // Tampered or truncated cookie.
  }
  return null;
}
