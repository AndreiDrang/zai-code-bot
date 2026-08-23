/**
 * Small D1 helpers. SQL stays behind storage modules so handlers can be tested
 * with a minimal D1-compatible fake and cannot accidentally use KV as state.
 */

export function prepare(db, sql, ...bindings) {
  if (!db || typeof db.prepare !== 'function') {
    throw new TypeError('A D1 database binding is required');
  }
  return db.prepare(sql).bind(...bindings);
}

export async function first(statement) {
  return statement.first();
}

export async function run(statement) {
  const result = await statement.run();
  return result?.meta || result || {};
}

export async function batch(db, statements) {
  if (!db || typeof db.batch !== 'function') {
    throw new TypeError('A D1 database binding is required');
  }
  return db.batch(statements);
}

export function changedRows(result) {
  return Number(result?.meta?.changes ?? result?.changes ?? 0);
}

export function safeErrorCode(error, fallback = 'storage_error') {
  const status = Number(error?.status);
  if (status === 429) return 'github_rate_limited';
  if (status >= 500) return 'github_unavailable';
  if (error?.code && /^[a-z0-9_]+$/.test(error.code)) return error.code;
  return fallback;
}

export function requireBinding(binding, name) {
  if (!binding) throw new Error(`${name} binding is not configured`);
  return binding;
}
