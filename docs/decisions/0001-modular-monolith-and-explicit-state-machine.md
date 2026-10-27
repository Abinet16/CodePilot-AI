# ADR 0001: Modular monolith, separate worker, explicit state machine

- Status: Accepted
- Date: 2026-10-27

## Context

The agent performs long-running, failure-prone work (cloning, LLM calls, test runs) and has external side effects (pushing branches, opening PRs). It must be auditable, resumable after crashes, and safe under retries.

## Decision

1. **NestJS modular monolith** for the API, with **one separate worker process** consuming a BullMQ queue. No microservices until load or team boundaries justify them.
2. **An explicit, persisted state machine** instead of an autonomous agent loop or multi-agent framework. Every AI operation is a stage with typed inputs and outputs, a defined permission set, and defined failure states.
3. **Compare-and-set transitions** recorded with an event row in one transaction.
4. **Queue payloads carry identifiers only**, never credentials or repository content.

## Consequences

- Behavior is predictable, testable per stage, and measurable by the benchmark suite.
- Resumability comes from persisted status rather than job-level checkpoints.
- Specialized agents can be added later as stage implementations if measurements justify them.
