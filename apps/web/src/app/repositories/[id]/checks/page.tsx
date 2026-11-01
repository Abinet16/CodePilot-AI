import type { RepositoryChecksResponse, RepositorySummary } from "@codepilot/contracts";
import { MIN_PERMISSION_TO_CONFIGURE_CHECKS } from "@codepilot/contracts";
import { notFound, redirect } from "next/navigation";
import { apiGet } from "@/lib/api";
import { ChecksForm } from "./checks-form";

export const dynamic = "force-dynamic";

export default async function RepositoryChecksPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const [checks, repos] = await Promise.all([
    apiGet<RepositoryChecksResponse>(`/repositories/${encodeURIComponent(id)}/checks`),
    apiGet<RepositorySummary[]>("/repositories"),
  ]);
  if (!checks.ok && checks.status === 401) redirect(`/api/auth/github/login?returnTo=/repositories/${encodeURIComponent(id)}/checks`);
  if (!checks.ok && (checks.status === 404 || checks.status === 400)) notFound();
  if (!checks.ok) return <p className="bad">Could not load the checks.</p>;

  const repository = repos.ok ? repos.data.find((r) => r.id === id) : undefined;
  const { configured, suggested, canEdit, updatedBy, updatedAt } = checks.data;

  return (
    <>
      <h1>Checks{repository && ` · ${repository.fullName}`}</h1>
      <p className="muted">
        After the agent writes a patch, these commands run in a disposable container: the install step with network access and
        lifecycle scripts disabled, then each check with no network, as a non-root user, under CPU, memory, and time limits. The
        agent never chooses a command; it only reads the results.
      </p>
      {updatedBy && updatedAt && (
        <p className="muted small">
          Last changed by {updatedBy} on {new Date(updatedAt).toLocaleString()}.
        </p>
      )}
      {!configured && <p className="notice small">No checks are configured yet, so tasks on this repository stop at RUNNING_CHECKS.</p>}
      {!canEdit && <p className="muted small">Only people with {MIN_PERMISSION_TO_CONFIGURE_CHECKS.toLowerCase()} access on GitHub can change checks.</p>}
      <section className="card">
        <ChecksForm repositoryId={id} configured={configured} suggested={suggested} canEdit={canEdit} />
      </section>
    </>
  );
}
