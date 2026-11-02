# ADR 0002: Pin to stable toolchain lines

- Status: Accepted
- Date: 2026-10-27

## Context

At project start, the newest majors were TypeScript 7 (native port), Prisma 8 (release candidate), NestJS 12, and Next.js 16. Their compatibility with ts-jest, Nest's decorator metadata, and each other was unproven.

## Decision

Pin exact versions on proven lines: TypeScript 5.9, Prisma 6.19, NestJS 11, Next.js 15, React 19.1, BullMQ 5, Zod 3.25 (now 4.6, see the amendment), Jest 29. pnpm's `minimumReleaseAge` gate stays on; a package too new to pass it is downgraded, not exempted.

## Consequences

- Configs already avoid options deprecated in TypeScript 6+ (`Node16` resolution, no `baseUrl`), so upgrading is a version bump plus fixes.
- Prisma 7+ moves the datasource URL to `prisma.config.ts` and requires driver adapters. That migration is a planned hardening task.

## Amendment (2026-11-02): security fixes

`pnpm audit --prod --audit-level high` failed in CI on five advisories. The fixes:

- **Zod 3.25 → 4.6.7** for GHSA-mrhx-c7xc-m3w5. No fixed 3.x release exists. Zod 4 is the current stable line, and `@anthropic-ai/sdk` accepts it as a peer. The only code change was the two-argument `z.record(key, value)`; every schema test, config default, and integration suite passes unchanged.
- **Scoped pnpm overrides** for vulnerable versions pinned by our dependencies, in `pnpm-workspace.yaml`:
  - `next>postcss` → 8.5.31 (GHSA-6g55-p6wh-862q, GHSA-r28c-9q8g-f849; next@15 pins 8.4.31)
  - `@nestjs/platform-express>multer` → 2.5.0 (GHSA-q7qp-rjg7-q26m; Nest 11 pins 2.4.0)
  - `@prisma/config>deepmerge-ts` → 8.0.2 (GHSA-ggr8-5vv4-36mx; Prisma 6.19 pins 7.1.5)

  Each override is scoped to the parent that pins the old version. Each stays within that package's public API (postcss and multer are minor bumps; Prisma's CLI was checked with `generate`, `migrate status`, and `migrate diff`). Each is removed once the parent ships the fix.

The release-age gate is pnpm's default `minimumReleaseAge`; this repository does not set a longer one. All versions chosen above had been published for at least ten days.
