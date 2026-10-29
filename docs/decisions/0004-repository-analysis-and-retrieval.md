# ADR 0004: Repository analysis and context retrieval

- Status: Accepted
- Date: 2026-10-29

## Context

Planning (week 4) needs the right slice of a repository, tied to an exact commit, within a fixed context budget. Repositories are untrusted: they can contain hooks, symlinks, secrets, huge or binary files, and text written to manipulate a model.

## Decision

1. **Pin first, then fetch by SHA.** The worker resolves the default branch to a SHA through the GitHub API and stores it on the task with a compare-and-set (`base_sha IS NULL`). Retries reuse it. git fetches exactly that commit (`--depth=1`) and `HEAD` is verified.
2. **Snapshots per (repository, commit).** Indexed files, chunks, and symbols hang off a `repository_snapshots` row written in one transaction. Tasks on an already-indexed commit skip cloning entirely, and concurrent indexers collapse on the unique key. Only the newest few snapshots are kept; the task's own context package is stored on the task, so pruning never breaks history.
3. **PostgreSQL full-text search before embeddings.** A generated `tsvector` over normalized identifier terms (camelCase and snake_case split, plus the joined form) gives useful code search with no new infrastructure or provider. Embeddings stay optional.
4. **Line-based symbol extraction instead of a compiler AST.** A regex declaration finder for TypeScript/JavaScript is fast, has no runtime dependency on `typescript`, and cannot execute anything. Imprecision only affects ranking.
5. **Four ranked signals, one budget.** Paths named in the task > symbol names > full-text rank > the repository's agent instructions. Chunks are merged, capped per file, and fit to a character budget (48k by default). Adjacent chunks are merged back into line ranges.
6. **TypeScript/JavaScript only proceed to planning.** Other ecosystems are still analyzed so the user can see why the task stopped.

## Consequences

- Analysis is cheap to repeat and safe to retry. Disk use is bounded per task and the workspace is always removed.
- Retrieval quality is lexical. A task phrased very differently from the code may need embeddings later; the snapshot model leaves room for an embedding column on `code_chunks`.
- Repository text (including AGENTS.md) enters the context package and is untrusted. Week 4 must delimit it and never treat it as instructions.
