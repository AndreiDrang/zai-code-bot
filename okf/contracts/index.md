# Contracts

Stable data contracts between components.

- [Queue message format](queue-message.md) — Messages carry only `{ schemaVersion, jobId }`; all large data stays in D1 and R2.
- [Transactional outbox](transactional-outbox.md) — The `job_outbox` table bridges the D1 commit and the Queue publish so a crash never loses a job.
- [Agent context tools](agent-context-tools.md) — Seven read-only LLM tools over one immutable PR snapshot, served through the Context Service DTO layer.
- [Agent tool-calling loop](agent-runner.md) — The bounded provider-neutral agent runner: iteration, call, and duration budgets with protocol validation and safe tool errors.
