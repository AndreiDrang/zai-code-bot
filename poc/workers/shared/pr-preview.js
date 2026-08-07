import { PR_PREVIEW_MARKER } from './constants.js';

function tableCell(value) {
  return String(value ?? '')
    .replaceAll('|', '\\|')
    .replaceAll('\n', ' ');
}

export function renderPrPreview({ repository, prNumber, headSha, title, authorLogin, stats }) {
  const rows = stats.files
    .map(
      (file) =>
        `| \`${tableCell(file.filename)}\` | ±${file.additions + file.deletions} | ${tableCell(file.status)} |`,
    )
    .join('\n');
  const truncation = stats.truncated
    ? '\n\n> ⚠️ File list truncated by the configured safety limit.'
    : '';
  return `## 🔍 Z.ai PR Preview

| Metric | Value |
| --- | --- |
| **Repository** | ${tableCell(repository)} |
| **PR** | #${prNumber} |
| **Title** | ${tableCell(title || 'Untitled')} |
| **Author** | @${tableCell(authorLogin || 'unknown')} |
| **Head** | \`${tableCell(headSha)}\` |
| **Files changed** | ${stats.changedFiles} |
| **Lines added** | +${stats.additions} |
| **Lines deleted** | -${stats.deletions} |

### 📁 Changed Files

| File | Changes | Status |
| --- | ---: | --- |
${rows || '| _(none)_ | 0 | — |'}${truncation}

---
*Powered by Z.ai* ${PR_PREVIEW_MARKER}`;
}
