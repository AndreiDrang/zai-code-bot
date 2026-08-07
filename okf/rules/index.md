# Rules

Operational policies that govern execution and retention.

- [Three-attempt retry budget](retry-budget.md) — Jobs get 3 attempts: two warnings then a terminal failure; no DLQ, D1 is the failure journal.
- [30-day R2 retention](r2-retention.md) — All `v1/`-prefixed objects expire after 30 days via an R2 lifecycle rule, complemented by an application-level sweep.
- [Collaborator authorization](authorization.md) — Only repository collaborators may run `/zai` commands (stricter than the parent bot).
