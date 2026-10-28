import "server-only";
import { cookies } from "next/headers";

const API_ORIGIN = process.env.API_ORIGIN ?? "http://localhost:4000";

export type ApiResult<T> = { ok: true; data: T } | { ok: false; status: number };

/** Server-side call to the API, forwarding the browser's session cookie. */
export async function apiGet<T>(path: string): Promise<ApiResult<T>> {
  const cookieHeader = (await cookies()).toString();
  try {
    const res = await fetch(`${API_ORIGIN}/api${path}`, {
      headers: cookieHeader ? { cookie: cookieHeader } : {},
      cache: "no-store",
    });
    if (!res.ok) return { ok: false, status: res.status };
    return { ok: true, data: (await res.json()) as T };
  } catch {
    return { ok: false, status: 0 };
  }
}
