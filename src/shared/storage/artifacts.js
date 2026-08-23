import { prepare, run } from './database.js';
import { runArtifactKey } from './keys.js';

const encoder = new TextEncoder();
export const R2_ARTIFACT_RETENTION_DAYS = 30;

export function artifactExpiresAt(
  createdAt = new Date(),
  retentionDays = R2_ARTIFACT_RETENTION_DAYS,
) {
  const days = Number.isFinite(Number(retentionDays))
    ? Math.max(1, Number(retentionDays))
    : R2_ARTIFACT_RETENTION_DAYS;
  return new Date(new Date(createdAt).getTime() + days * 24 * 60 * 60 * 1000).toISOString();
}

async function sha256Hex(bytes) {
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function bytesFor(content) {
  if (content instanceof Uint8Array) return content;
  if (content instanceof ArrayBuffer) return new Uint8Array(content);
  return encoder.encode(String(content));
}

/** Writes an immutable R2 object and records its D1 index. */
export async function writeArtifact({
  bucket,
  db,
  jobId,
  runId,
  kind,
  content,
  contentType = 'application/json',
  extension = 'json',
  expiresAt = null,
}) {
  if (!bucket || typeof bucket.put !== 'function')
    throw new TypeError('BOT_ARTIFACTS R2 binding is required');
  const bytes = bytesFor(content);
  const hash = await sha256Hex(bytes);
  const effectiveExpiresAt = expiresAt || artifactExpiresAt();
  const key = runArtifactKey(jobId, runId, kind, extension);
  const artifactId = crypto.randomUUID();
  await bucket.put(key, bytes, {
    httpMetadata: { contentType },
    customMetadata: { sha256: hash, artifactId, jobId, runId, kind },
  });
  await run(
    prepare(
      db,
      `INSERT INTO artifacts
       (artifact_id, job_id, kind, r2_key, sha256, byte_length, content_type, expires_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      artifactId,
      jobId,
      kind,
      key,
      hash,
      bytes.byteLength,
      contentType,
      effectiveExpiresAt,
      new Date().toISOString(),
    ),
  );
  return { artifactId, key, sha256: hash, byteLength: bytes.byteLength };
}

export async function readArtifact(bucket, key) {
  if (!bucket || typeof bucket.get !== 'function')
    throw new TypeError('BOT_ARTIFACTS R2 binding is required');
  return bucket.get(key);
}

export async function listExpiredArtifacts(db, limit = 100, now = new Date().toISOString()) {
  const result = await prepare(
    db,
    `SELECT artifact_id, r2_key FROM artifacts WHERE expires_at IS NOT NULL AND expires_at <= ? ORDER BY expires_at LIMIT ?`,
    now,
    Math.min(Math.max(Number(limit) || 1, 1), 500),
  ).all();
  return result?.results || [];
}

export async function deleteExpiredArtifacts({
  db,
  bucket,
  limit = 100,
  now = new Date().toISOString(),
}) {
  if (!bucket || typeof bucket.delete !== 'function')
    throw new TypeError('BOT_ARTIFACTS R2 binding is required');
  const artifacts = await listExpiredArtifacts(db, limit, now);
  for (const artifact of artifacts) {
    await bucket.delete(artifact.r2_key);
    await run(prepare(db, 'DELETE FROM artifacts WHERE artifact_id = ?', artifact.artifact_id));
  }
  return { found: artifacts.length, deleted: artifacts.length };
}

export function jsonArtifact(value) {
  return JSON.stringify(value);
}
