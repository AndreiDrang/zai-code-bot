/**
 * Shared LLM context-block builder.
 *
 * Pure function: turns the gathered PR-context slices (files, diff, commits,
 * description, comments) into ONE bounded Markdown block that a heavy command
 * handler appends to its user prompt. Each command selects a *layout* that
 * decides which slices are included and how the byte budget is split; for
 * `review` the diff is the primary input and absorbs the budget remaining after
 * the secondary slices are bounded.
 *
 * The slice shapes are those the eager gather writes
 * (zai-heavy-worker/src/handlers/pr-context.js) and that
 * Context Service supplies:
 *   - diff, description : string (`diff` is bounded and assembled from V2
 *                         per-file patch artifacts)
 *   - files             : [{ path, status, additions, deletions, changes, diff }]
 *   - commits           : [{ sha, title, message, author, date }]
 *   - comments          : { issue: [{user, body, created_at, updated_at}],
 *                           review: [{user, body, path, line, updated_at}] }
 *
 * Every renderer is defensive: a missing/empty/null slice yields an empty
 * section (the block never throws on partial context).
 */

/** Cap for the PR title heading line. */
const TITLE_MAX = 200;

/** Reserved bytes for the diff section's markdown wrapper (header + fences). */
const DIFF_WRAPPER_OVERHEAD = 40;

/**
 * Build the context block for a command's user prompt.
 *
 * @param {Object} opts
 * @param {Object} opts.slices - { diff, description, files, commits, comments }
 * @param {string} opts.command - command name selecting the layout ('review'|'pr-summary')
 * @param {number} [opts.budgetBytes=200000] - total soft cap for the block
 * @param {Object} [opts.meta] - optional { title, author } prepended as a header
 * @param {Object} [opts.summary] - previously generated summary for review context
 * @returns {string} Markdown block (may be shorter than budget; never throws)
 */
export function buildContextBlock({ slices, command, budgetBytes = 200000, meta, summary } = {}) {
  const layout = LAYOUTS[command];
  if (!layout) {
    throw new Error(`buildContextBlock: no layout for command "${command}"`);
  }
  const s = slices || {};
  const parts = [];

  if (meta?.title) parts.push(`# ${truncateTo(meta.title, TITLE_MAX)}`);
  if (meta?.author) parts.push(`by @${meta.author}`);

  // Secondary slices are rendered first under fixed sub-caps; the diff (primary)
  // absorbs the budget left over so it always gets the lion's share.
  const summaryCap = Math.min(layout.summaryCap || 0, Math.floor(budgetBytes * 0.08));
  const descriptionCap = Math.min(layout.descriptionCap, Math.floor(budgetBytes * 0.05));
  const commitsCap = Math.min(layout.commitsCap, Math.floor(budgetBytes * 0.06));
  const commentsCap = Math.min(layout.commentsCap, Math.floor(budgetBytes * 0.08));
  const filesCap = Math.min(layout.filesCap, Math.floor(budgetBytes * 0.03));

  const generatedSummary = renderPrSummary(summary, summaryCap);
  const description = renderDescription(s.description, descriptionCap);
  const commits = layout.includeCommits
    ? renderCommits(s.commits, commitsCap, layout.includeCommitMessages)
    : '';
  const comments = layout.includeComments ? renderComments(s.comments, commentsCap) : '';
  const files = renderFiles(s.files, filesCap, layout.includeFileStats);

  parts.push(generatedSummary, description, commits, comments, files);

  // Diff is rendered last and absorbs the remaining budget. The diff wrapper
  // (`## Diff\n\n```diff\n…\n````) adds fixed markdown overhead the cap must
  // reserve for so the final block stays under budgetBytes.
  const overhead = parts.join('\n\n').length;
  const diffCap = Math.max(2000, budgetBytes - overhead - DIFF_WRAPPER_OVERHEAD);
  parts.push(renderDiff(s.diff, diffCap));

  return parts.filter(Boolean).join('\n\n');
}

/**
 * Per-command layouts. Caps are absolute upper bounds (the budget-relative cap
 * applied in buildContextBlock may be smaller).
 */
const LAYOUTS = {
  review: {
    summaryCap: 6000,
    includeCommits: true,
    includeComments: true,
    descriptionCap: 4000,
    commitsCap: 6000,
    commentsCap: 8000,
    filesCap: 3000,
  },
  'pr-summary': {
    includeCommits: true,
    includeCommitMessages: true,
    includeComments: true,
    includeFileStats: true,
    descriptionCap: 8000,
    commitsCap: 12000,
    commentsCap: 20000,
    filesCap: 8000,
  },
};

// ---------------------------------------------------------------------------
// slice renderers — each returns '' on missing/empty input
// ---------------------------------------------------------------------------

function renderDescription(description, cap) {
  const text = typeof description === 'string' ? description.trim() : '';
  if (!text) return '';
  return `## Description\n\n${truncateTo(text, cap)}`;
}

function renderCommits(commits, cap, includeMessages = false) {
  const list = Array.isArray(commits) ? commits : [];
  if (!list.length) return '';
  const lines = list.map((c) => {
    const sha = c?.sha ? `\`${String(c.sha).slice(0, 7)}\`` : '`(no-sha)`';
    const title = c?.title ? truncateTo(String(c.title).replace(/\n/g, ' '), 160) : '(no subject)';
    const author = c?.author ? ` — ${c.author}` : '';
    const message =
      includeMessages && c?.message && String(c.message) !== String(c.title || '')
        ? `\n  ${truncateTo(String(c.message), 1200)}`
        : '';
    return `- ${sha} ${title}${author}${message}`;
  });
  const body = truncateTo(lines.join('\n'), cap);
  return `## Commits (${list.length})\n\n${body}`;
}

function renderComments(comments, cap) {
  const issue = comments?.issue;
  const review = comments?.review;
  const issueList = Array.isArray(issue) ? issue : [];
  const reviewList = Array.isArray(review) ? review : [];
  if (!issueList.length && !reviewList.length) return '';

  const sections = [];
  if (issueList.length) {
    sections.push(
      `### Issue comments (${issueList.length})\n\n` +
        truncateTo(issueList.map(formatIssueComment).join('\n\n'), Math.floor(cap * 0.5)),
    );
  }
  if (reviewList.length) {
    sections.push(
      `### Review comments (${reviewList.length})\n\n` +
        truncateTo(reviewList.map(formatReviewComment).join('\n\n'), Math.floor(cap * 0.5)),
    );
  }
  return `## Conversation\n\n${sections.join('\n\n')}`;
}

function formatIssueComment(c) {
  const user = c?.user ? `**@${c.user}**` : '**(anon)**';
  const body = c?.body ? truncateTo(String(c.body), 800) : '';
  return `${user}: ${body}`;
}

function formatReviewComment(c) {
  const user = c?.user ? `**@${c.user}**` : '**(anon)**';
  const loc = c?.path ? ` on \`${c.path}\`${c?.line ? `:${c.line}` : ''}` : '';
  const body = c?.body ? truncateTo(String(c.body), 800) : '';
  return `${user}${loc}: ${body}`;
}

function renderFiles(files, cap, includeStats = false) {
  const list = Array.isArray(files) ? files : [];
  if (!list.length) return '';
  const entries = list
    .filter((f) => f?.filename || f?.path)
    .map((f) => {
      const path = f.filename || f.path;
      if (!includeStats) return `- ${path}`;
      return (
        `- ${path} (${f.status || 'changed'}, ` +
        `+${Number(f.additions) || 0}/-${Number(f.deletions) || 0})`
      );
    });
  if (!entries.length) return '';
  const body = truncateTo(entries.join('\n'), cap);
  return `## Changed files (${entries.length})\n\n${body}`;
}

function renderPrSummary(summary, cap) {
  if (!summary || cap <= 0) return '';
  const value = summary.summary || summary;
  if (!value || typeof value !== 'object') return '';

  const lines = [];
  if (value.prSummary) lines.push(`**Summary:** ${String(value.prSummary)}`);
  if (Array.isArray(value.keyChanges) && value.keyChanges.length) {
    lines.push(
      '**Key changes:**\n' +
        value.keyChanges
          .filter((change) => change?.file && change?.change)
          .map((change) => `- \`${change.file}\`: ${change.change}`)
          .join('\n'),
    );
  }
  const conversation = value.conversationSummary;
  if (conversation) {
    lines.push(
      `**Conversation:** ${conversation.mainTopic || 'No meaningful discussion recorded.'}`,
    );
    if (
      Array.isArray(conversation.unresolvedQuestions) &&
      conversation.unresolvedQuestions.length
    ) {
      lines.push(
        '**Unresolved questions:**\n' +
          conversation.unresolvedQuestions.map((question) => `- ${question}`).join('\n'),
      );
    }
  }
  if (!lines.length) return '';
  return `## Generated PR summary\n\n${truncateTo(lines.join('\n\n'), cap)}`;
}

function renderDiff(diff, cap) {
  const text = typeof diff === 'string' ? diff : '';
  if (!text.trim()) return '';
  const body = truncateTo(text, cap);
  return `## Diff\n\n\`\`\`diff\n${body}\n\`\`\``;
}

/** Truncate a string to `max` chars, appending an ellipsis marker when cut. */
function truncateTo(text, max) {
  const str = String(text ?? '');
  if (str.length <= max) return str;
  return `${str.slice(0, Math.max(0, max - 14))}\n…(truncated)`;
}

export { LAYOUTS };
