import {
  prCardKey,
  prContextKey,
  prContextDiffKey,
  prCommandResultKey,
  prSummaryKey,
} from './storage/keys.js';

/**
 * Read-helpers for the PR-context tier, shared by the review and describe
 * handlers. These are the READERS that pair with the gather job's writes.
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
 * Reads the PR's context manifest — the index of what the gather captured
 * (counts, aggregates, which headSha it describes). Keyed per PR (not per head),
 * so this always returns the LATEST gathered snapshot. Returns null when no
 * gather has run for this PR yet.
 * @returns {Promise<Object|null>}
 */
export async function readContextManifest(bucket, repositoryId, prNumber) {
  if (!bucket?.get || repositoryId == null || prNumber == null) return null;
  try {
    const object = await getExistingObject(
      bucket,
      prContextKey(repositoryId, prNumber, 'manifest'),
    );
    if (!object) return null;
    const manifest = JSON.parse(await object.text());
    return manifest?.schemaVersion === 2 && typeof manifest.headSha === 'string' ? manifest : null;
  } catch {
    return null;
  }
}

/**
 * Reads a single gathered context slice from R2 (the PR's latest snapshot).
 * `description` is stored as text; the other kinds (files, commits, comments)
 * are JSON. Per-file patches are read through `readContextDiff` after resolving
 * their entry from `files.json`.
 * @returns {Promise<string|Object|null>}
 */
export async function readContextSlice(bucket, repositoryId, prNumber, kind) {
  if (!bucket?.get || repositoryId == null || prNumber == null) return null;
  try {
    const object = await getExistingObject(bucket, prContextKey(repositoryId, prNumber, kind));
    if (!object) return null;
    const text = await object.text();
    return kind === 'description' ? text : JSON.parse(text);
  } catch {
    return null;
  }
}

export async function readContextFiles(bucket, repositoryId, prNumber) {
  const files = await readContextSlice(bucket, repositoryId, prNumber, 'files');
  return Array.isArray(files) ? files : null;
}

/**
 * Reads the patch identified by an already-indexed V2 file entry. The caller
 * must resolve `fileEntry` from files.json first; arbitrary user paths never
 * flow directly into an R2 key.
 * @returns {Promise<string|null>}
 */
export async function readContextDiff(bucket, repositoryId, prNumber, fileEntry) {
  if (!bucket?.get || repositoryId == null || prNumber == null) return null;
  if (fileEntry?.diff?.state !== 'available' || typeof fileEntry.path !== 'string') return null;
  try {
    const expectedKey = prContextDiffKey(repositoryId, prNumber, fileEntry.path);
    if (fileEntry.diff.key !== expectedKey) return null;
    const object = await getExistingObject(bucket, expectedKey);
    return object ? await object.text() : null;
  } catch {
    return null;
  }
}

/**
 * Reads a stored COMMAND RESULT — the latest LLM output of one /zai command for
 * one PR (`v2/prs/{repo}/{pr}/context/{command}.md`). Pairs with the
 * runLlmCommand runner's write so the command-result tier is never write-only:
 * the published comment can note/links the latest result, and a future
 * `/zai <cmd> --last` reads from here. Best-effort like the slice readers.
 * @returns {Promise<string|null>}
 */
export async function readCommandResult(bucket, repositoryId, prNumber, command) {
  if (!bucket?.get || repositoryId == null || prNumber == null || command == null) return null;
  try {
    const object = await getExistingObject(
      bucket,
      prCommandResultKey(repositoryId, prNumber, command),
    );
    if (!object) return null;
    return await object.text();
  } catch {
    return null;
  }
}

/**
 * Reads the latest generated structured PR summary. The caller is responsible
 * for comparing `headSha` with the current context manifest before using it.
 * @returns {Promise<Object|null>}
 */
export async function readPrSummary(bucket, repositoryId, prNumber) {
  if (!bucket?.get || repositoryId == null || prNumber == null) return null;
  try {
    const object = await getExistingObject(bucket, prSummaryKey(repositoryId, prNumber));
    if (!object) return null;
    const value = JSON.parse(await object.text());
    return value?.schemaVersion === 1 && value?.summary ? value : null;
  } catch {
    return null;
  }
}

/**
 * R2 list preflight returns an empty object list for a missing key without
 * producing a noisy GetObject/HeadObject error span in Observability. Keep
 * head() and get()-only fallbacks for lightweight test doubles and older
 * bindings.
 */
async function getExistingObject(bucket, key) {
  if (typeof bucket.list === 'function') {
    const result = await bucket.list({ prefix: key, limit: 1 });
    if (!result?.objects?.some((object) => object.key === key)) return null;
  } else if (typeof bucket.head === 'function') {
    const metadata = await bucket.head(key);
    if (!metadata) return null;
  }
  return bucket.get(key);
}

/**
 * Renders a compact "what context is ready" block for a context-aware comment.
 * Used by review and describe status comments.
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
