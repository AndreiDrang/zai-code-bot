import { first, prepare, run } from './database.js';
import { repoConfigCacheKey } from './keys.js';

export const DEFAULT_REPOSITORY_CONFIG = Object.freeze({
  enabled: true,
  autoPreview: true,
  maxFiles: 100,
  maxContextBytes: 200000,
  retentionProfile: 'default',
  version: 1,
});

function fromRow(row) {
  if (!row) return null;
  return {
    enabled: Boolean(row.enabled),
    autoPreview: Boolean(row.auto_preview),
    maxFiles: Number(row.max_files),
    maxContextBytes: Number(row.max_context_bytes),
    retentionProfile: row.retention_profile,
    version: Number(row.version),
  };
}

export async function getRepositoryConfig(db, cache, repositoryId) {
  const cacheKey = repoConfigCacheKey(repositoryId);
  if (cache?.get) {
    try {
      const hit = await cache.get(cacheKey, { type: 'json' });
      if (hit) return hit;
    } catch {
      // KV is derivative; an outage must not change repository policy.
    }
  }
  const row = await first(
    prepare(db, 'SELECT * FROM repository_configs WHERE repository_id = ?', repositoryId),
  );
  const config = fromRow(row) || { ...DEFAULT_REPOSITORY_CONFIG };
  if (cache?.put) {
    try {
      await cache.put(cacheKey, JSON.stringify(config), { expirationTtl: 300 });
    } catch {
      // KV is derivative; a cache outage must not change repository policy.
    }
  }
  return config;
}

export async function saveRepositoryConfig(
  db,
  cache,
  repositoryId,
  patch,
  now = new Date().toISOString(),
) {
  const current = await getRepositoryConfig(db, null, repositoryId);
  const next = { ...current, ...patch, version: current.version + 1 };
  await run(
    prepare(
      db,
      `INSERT INTO repository_configs
       (repository_id, enabled, auto_preview, max_files, max_context_bytes, retention_profile, version, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(repository_id) DO UPDATE SET
         enabled = excluded.enabled, auto_preview = excluded.auto_preview,
         max_files = excluded.max_files, max_context_bytes = excluded.max_context_bytes,
         retention_profile = excluded.retention_profile, version = excluded.version,
         updated_at = excluded.updated_at`,
      repositoryId,
      next.enabled ? 1 : 0,
      next.autoPreview ? 1 : 0,
      next.maxFiles,
      next.maxContextBytes,
      next.retentionProfile,
      next.version,
      now,
    ),
  );
  if (cache?.delete) {
    // Non-versioned read-through key: delete on save keeps it fresh; a missed
    // delete is bounded by the 300s TTL on the write-back in getRepositoryConfig.
    try {
      await cache.delete(repoConfigCacheKey(repositoryId));
    } catch {
      /* best effort cache invalidation; staleness is TTL-bounded */
    }
  }
  return next;
}
