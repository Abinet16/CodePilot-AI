export const SESSION_COOKIE = "cp_session";
export const OAUTH_STATE_COOKIE = "cp_oauth_state";

/** Minimal RFC 6265 cookie header parser. The first occurrence of a name wins. */
export function parseCookies(header: string | undefined): Record<string, string> {
  const cookies: Record<string, string> = {};
  if (!header) return cookies;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    const name = part.slice(0, eq).trim();
    if (!name || name in cookies) continue;
    try {
      cookies[name] = decodeURIComponent(part.slice(eq + 1).trim());
    } catch {
      // Malformed percent-encoding: ignore this cookie.
    }
  }
  return cookies;
}
