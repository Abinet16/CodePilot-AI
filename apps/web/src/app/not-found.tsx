import Link from "next/link";

/** Unknown pages, and anything the user cannot see: the API reports both the same way. */
export default function NotFound() {
  return (
    <section className="card">
      <h1>Not found</h1>
      <p className="muted">This page does not exist, or you do not have access to it on GitHub.</p>
      <p>
        <Link href="/">Go to the dashboard</Link>
      </p>
    </section>
  );
}
