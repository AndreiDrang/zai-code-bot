import { describe, expect, it, vi } from 'vitest';
import { getRepositoryConfig, DEFAULT_REPOSITORY_CONFIG } from '../shared/storage/config.js';
import { repoConfigCacheKey } from '../shared/storage/keys.js';

// getRepositoryConfig is now a KV read-through: on a hit it returns the cached
// object WITHOUT touching D1; on a miss it reads D1 and writes the result back
// (300s TTL). KV is derivative, so an outage must fall through to D1 silently.

function makeDb(firstValue) {
  // Mirrors the storage-state fake: db.prepare(sql).bind(...) -> statement.
  const statements = [];
  const db = {
    statements,
    prepare(sql) {
      return {
        bind: (...bindings) => {
          const statement = {
            sql,
            bindings,
            first: vi.fn().mockResolvedValue(firstValue),
            all: vi.fn(),
            run: vi.fn(),
          };
          statements.push(statement);
          return statement;
        },
      };
    },
  };
  return db;
}

describe('getRepositoryConfig — KV read-through', () => {
  it('returns the cached config on a hit WITHOUT querying D1 or writing back', async () => {
    // D1 would return no row (null) — if the cache were bypassed we'd get the
    // defaults. A non-default cached object proves the hit path wins.
    const db = makeDb(null);
    const cached = { enabled: false, autoPreview: true, maxFiles: 50, version: 7 };
    const cache = {
      get: vi.fn().mockResolvedValue(cached),
      put: vi.fn(),
    };

    const config = await getRepositoryConfig(db, cache, 10);

    expect(config).toEqual(cached);
    expect(cache.get).toHaveBeenCalledWith(repoConfigCacheKey(10), { type: 'json' });
    // D1 was never consulted and nothing is written back on a hit.
    expect(db.statements).toHaveLength(0);
    expect(cache.put).not.toHaveBeenCalled();
  });

  it('reads D1 on a miss and writes the config back to the cache (300s TTL)', async () => {
    const row = {
      enabled: 1,
      auto_preview: 1,
      max_files: 20,
      max_context_bytes: 1000,
      retention_profile: 'default',
      version: 2,
    };
    const db = makeDb(row);
    const cache = {
      get: vi.fn().mockResolvedValue(null),
      put: vi.fn().mockResolvedValue(undefined),
    };

    const config = await getRepositoryConfig(db, cache, 10);

    expect(config).toMatchObject({ maxFiles: 20, version: 2 });
    expect(cache.get).toHaveBeenCalledOnce();
    expect(cache.put).toHaveBeenCalledWith(repoConfigCacheKey(10), JSON.stringify(config), {
      expirationTtl: 300,
    });
  });

  it('caches the default config when no D1 row exists', async () => {
    const db = makeDb(null);
    const cache = {
      get: vi.fn().mockResolvedValue(null),
      put: vi.fn().mockResolvedValue(undefined),
    };

    const config = await getRepositoryConfig(db, cache, 10);

    expect(config).toMatchObject({ ...DEFAULT_REPOSITORY_CONFIG });
    expect(cache.put).toHaveBeenCalledWith(repoConfigCacheKey(10), JSON.stringify(config), {
      expirationTtl: 300,
    });
  });

  it('falls through to D1 when the cache get throws (derivative, not authoritative)', async () => {
    const row = {
      enabled: 1,
      auto_preview: 0,
      max_files: 5,
      max_context_bytes: 100,
      retention_profile: 'default',
      version: 1,
    };
    const db = makeDb(row);
    const cache = {
      get: vi.fn().mockRejectedValue(new Error('KV down')),
      put: vi.fn().mockRejectedValue(new Error('KV down')),
    };

    // Must not throw — KV is derivative.
    const config = await getRepositoryConfig(db, cache, 10);

    expect(config).toMatchObject({ autoPreview: false, maxFiles: 5 });
    expect(db.statements).toHaveLength(1);
  });

  it('skips the cache entirely when no cache binding is provided', async () => {
    const row = {
      enabled: 1,
      auto_preview: 1,
      max_files: 100,
      max_context_bytes: 200000,
      retention_profile: 'default',
      version: 1,
    };
    const db = makeDb(row);

    const config = await getRepositoryConfig(db, null, 10);

    expect(config).toMatchObject({ maxFiles: 100 });
    expect(db.statements).toHaveLength(1);
  });
});
