# ADR 0002: Pin to stable toolchain lines

- Status: Accepted
- Date: 2026-10-27

## Context

At project start, the newest majors were TypeScript 7 (native port), Prisma 8 (release candidate), NestJS 12, and Next.js 16. Their compatibility with ts-jest, Nest's decorator metadata, and each other was unproven.

## Decision

Pin exact versions on proven lines: TypeScript 5.9, Prisma 6.19, NestJS 11, Next.js 15, React 19.1, BullMQ 5, Zod 3.25, Jest 29. pnpm's `minimumReleaseAge` gate stays on; a package too new to pass it is downgraded, not exempted.

## Consequences

- Configs already avoid options deprecated in TypeScript 6+ (`Node16` resolution, no `baseUrl`), so upgrading is a version bump plus fixes.
- Prisma 7+ moves the datasource URL to `prisma.config.ts` and requires driver adapters. That migration is a planned hardening task.
