-- Track who closed a pull request (the webhook `sender`), used by the heavy
-- worker to render the idempotent "PR closed by @X" lifecycle comment. GitHub's
-- PR API does not expose closed_by, so it is captured once from the webhook and
-- persisted here. NULL for open PRs; preserved across non-close events via
-- COALESCE in the pull_requests UPSERT (shared/storage/deliveries.js).
PRAGMA foreign_keys = ON;

ALTER TABLE pull_requests ADD COLUMN closed_by TEXT;
