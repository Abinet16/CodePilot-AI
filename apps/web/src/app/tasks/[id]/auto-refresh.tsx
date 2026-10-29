"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";

/** Re-renders the server page while the task is still moving. */
export function AutoRefresh({ intervalMs = 3_000 }: { intervalMs?: number }) {
  const router = useRouter();
  useEffect(() => {
    const timer = setInterval(() => router.refresh(), intervalMs);
    return () => clearInterval(timer);
  }, [router, intervalMs]);
  return null;
}
