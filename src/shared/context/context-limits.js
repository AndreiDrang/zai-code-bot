/**
 * Snapshot limits protect R2 collection independently from LLM prompt and
 * tool-result budgets. A skipped artifact is represented explicitly in the
 * file index; its bytes are never silently truncated.
 */
export const MAX_SNAPSHOT_FILE_DIFF_BYTES = 1024 * 1024;
export const MAX_SNAPSHOT_TOTAL_DIFF_BYTES = 20 * 1024 * 1024;
export const DEFAULT_CONTEXT_DIFF_RESULT_BYTES = 100 * 1024;
export const DEFAULT_CONTEXT_FILE_RESULT_BYTES = 100 * 1024;
export const MAX_CONTEXT_FILE_RANGE_LINES = 500;
export const MAX_CONTEXT_FILE_SOURCE_BYTES = 5 * 1024 * 1024;

export function utf8ByteLength(value) {
  return new TextEncoder().encode(String(value ?? '')).byteLength;
}
