"use client";

import Link from "next/link";

/** Shown when a page throws while rendering. The error itself is not displayed; it may hold server details. */
export default function ErrorPage({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <section className="card" role="alert">
      <h1>Something went wrong</h1>
      <p className="muted">The page could not be loaded. The API may be restarting; try again in a moment.</p>
      <p className="toggle">
        <button className="button" onClick={reset}>
          Try again
        </button>
        <Link href="/">Go to the dashboard</Link>
      </p>
    </section>
  );
}
