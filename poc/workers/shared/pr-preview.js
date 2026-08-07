import { PR_PREVIEW_MARKER, BOT_FOOTER } from './constants.js';

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
