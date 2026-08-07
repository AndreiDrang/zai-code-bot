# Contracts

Stable data contracts between components.

- [Queue message format](queue-message.md) — Messages carry only `{ schemaVersion, jobId }`; all large data stays in D1 and R2.
- [Transactional outbox](transactional-outbox.md) — The `job_outbox` table bridges the D1 commit and the Queue publish so a crash never loses a job.
