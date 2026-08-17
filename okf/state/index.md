# State

Stateful entities with defined lifecycles.

- [Job lifecycle and bounded leases](job-lifecycle.md) — The durable job state machine (`queued` → `running` → terminal) for all four job kinds, with 10-minute leases that prevent duplicate concurrent execution.
- [One-live-comment publication](comment-publication.md) — Exactly one bot comment per `(repo, PR, kind)` is kept live and updated across pushes via a D1 publication lease.
