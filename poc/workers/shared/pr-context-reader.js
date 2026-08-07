import { prCardKey, prContextKey } from './storage/keys.js';

/**
 * Read-helpers for the PR-context tier, shared by the command handlers
 * (review/impact/ask/explain). These are the READERS that pair with the gather
 * job's writes — together they satisfy the anti-write-only rule: every R2/KV
 * write from the gather has a command-path reader.
 *
 * Both helpers are best-effort: a KV/R2 miss or outage returns null and the
 * caller degrades gracefully (the storage tiers are derivative).
 */

/**
 * Reads the KV pr-card — the latest gathered PR shape (head, title, author,
 * counts, context-ready flag). Keyed by (repositoryId, prNumber) so a command
 * handler gets the shape WITHOUT calling getPullRequest.
 * @returns {Promise<Object|null>}
 */
export async function readPrCard(cache, repositoryId, prNumber) {
  if (!cache?.get || repositoryId == null || prNumber == null) return null;
  try {
    return await cache.get(prCardKey(repositoryId, prNumber), { type: 'json' });
  } catch {
    return null; // KV is derivative — a miss/outage degrades, not fails
  }
}

/**
 * Reads the R2 context manifest for a specific head — the index of what the
 * gather captured (counts, aggregates, context prefix). Returns null when the
 * gather has not yet run for this head.
 * @returns {Promise<Object|null>}
 */
export async function readContextManifest(bucket, repositoryId, prNumber, headSha) {
  if (!bucket?.get || !headSha) return null;
  try {
    const object = await bucket.get(prContextKey(repositoryId, prNumber, headSha, 'manifest'));
    if (!object) return null;
    return JSON.parse(await object.text());
  } catch {
    return null;
  }
}

/**
 * Reads a single gathered context slice from R2. `diff` and `description`
 * are stored as text; the other kinds (files, commits, comments) are JSON.
 * Best-effort: a miss or outage returns null so the caller falls back to a
 * live fetch rather than failing.
 * @returns {Promise<string|Object|null>}
 */
export async function readContextSlice(bucket, repositoryId, prNumber, headSha, kind) {
  if (!bucket?.get || !headSha) return null;
  try {
    const object = await bucket.get(prContextKey(repositoryId, prNumber, headSha, kind));
    if (!object) return null;
    const text = await object.text();
    return kind === 'diff' || kind === 'description' ? text : JSON.parse(text);
  } catch {
    return null;
  }
}

/**
 * Renders a compact "what context is ready" block for a context-aware comment.
 * Used by review/impact until the LLM pipeline lands. Returns an empty string
 * when no manifest exists (caller shows a "not yet gathered" notice instead).
 */
export function renderContextSummary(manifest) {
  if (!manifest) return '';
  const c = manifest.counts || {};
  const a = manifest.aggregates || {};
  return [
    `PR context for \`${manifest.headSha}\` is gathered and ready:`,
    `- **${c.files ?? 0} files** changed (+${a.additions ?? 0}/−${a.deletions ?? 0})`,
    `- **${c.commits ?? 0} commits**, **${(c.issueComments ?? 0) + (c.reviewComments ?? 0)} comments**`,
  ].join('\n');
}

/**
 * Renders a one-line PR-shape summary from the KV card, for ask/explain stubs.
 * Returns '' when no card is available.
 */
export function renderPrCardShape(card) {
  if (!card) return '';
  const files = card.changedFiles ?? 0;
  return `PR context: #${card.prNumber} by @${card.authorLogin || 'unknown'} at \`${card.headSha}\` — ${files} files (+${card.additions ?? 0}/−${card.deletions ?? 0}).`;
}
