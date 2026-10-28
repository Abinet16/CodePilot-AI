import type { RepositorySummary } from "@codepilot/contracts";
import { redirect } from "next/navigation";
import { apiGet } from "@/lib/api";
import { RepositoryToggle } from "./repository-toggle";

export const dynamic = "force-dynamic";

export default async function RepositoriesPage() {
  const repos = await apiGet<RepositorySummary[]>("/repositories");
  if (!repos.ok && repos.status === 401) redirect("/api/auth/github/login?returnTo=/repositories");

  return (
    <>
      <div className="heading-row">
        <h1>Repositories</h1>
        <a className="button" href="/api/github/install">
          Add repositories on GitHub
        </a>
      </div>
      <p className="muted">
        You see the repositories GitHub says you can access. The agent only works on repositories that someone with
        write access has enabled.
      </p>

      {!repos.ok ? (
        <p className="bad">Could not load repositories.</p>
      ) : repos.data.length === 0 ? (
        <section className="card">
          <p>No repositories yet. Install the GitHub App on at least one repository to get started.</p>
        </section>
      ) : (
        <table className="table">
          <thead>
            <tr>
              <th>Repository</th>
              <th>Your access</th>
              <th>Agent</th>
            </tr>
          </thead>
          <tbody>
            {repos.data.map((repo) => (
              <tr key={repo.id}>
                <td>
                  <a href={`https://github.com/${repo.fullName}`} target="_blank" rel="noreferrer">
                    {repo.fullName}
                  </a>
                  {repo.isPrivate && <span className="tag">private</span>}
                  {repo.installationStatus !== "ACTIVE" && <span className="tag bad">{repo.installationStatus.toLowerCase()}</span>}
                </td>
                <td>{repo.permission.toLowerCase()}</td>
                <td>
                  <RepositoryToggle repository={repo} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </>
  );
}
