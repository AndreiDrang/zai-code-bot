import { PR_PREVIEW_MARKER, PR_CLOSED_MARKER, BOT_FOOTER } from './constants.js';

function tableCell(value) {
  return String(value ?? '')
    .replaceAll('|', '\\|')
    .replaceAll('\n', ' ');
}

/**
 * Renders the metadata-only PR preview comment.
 *
 * No stats (files/additions/deletions) are computed or stored — the brief is
 * intentionally a lightweight identity card for the PR. Per-file data is the
 * job of the heavy /zai review pipeline, not the auto-preview.
 */
export function renderPrPreview({ repository, prNumber, headSha, title, authorLogin }) {
  return `## PR Preview

| Metric | Value |
| --- | --- |
| **Repository** | ${tableCell(repository)} |
| **PR** | #${prNumber} |
| **Title** | ${tableCell(title || 'Untitled')} |
| **Author** | @${tableCell(authorLogin || 'unknown')} |
| **Head** | \`${tableCell(headSha)}\` |

---
${BOT_FOOTER} ${PR_PREVIEW_MARKER}`;
}

/**
 * Renders the one-time PR-closed lifecycle comment. `closedBy` is the webhook
 * `sender` (who closed the PR), persisted on pull_requests.closed_by. Posted
 * via the idempotent comment-publication path (commentKind 'pr_closed') so
 * redelivery updates the same comment instead of duplicating it.
 */
export function renderPrClosed({ closedBy }) {
  return `## 🔒 PR Closed

PR closed by @${tableCell(closedBy || 'unknown')}.

---
${BOT_FOOTER} ${PR_CLOSED_MARKER}`;
}
