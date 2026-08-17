import {
  readContextDiff,
  readContextFiles,
  readContextManifest,
  readContextSlice,
} from '../pr-context-reader.js';
import { normalizeRepositoryPath } from '../storage/keys.js';
import {
  DEFAULT_CONTEXT_DIFF_RESULT_BYTES,
  DEFAULT_CONTEXT_FILE_RESULT_BYTES,
  MAX_CONTEXT_FILE_RANGE_LINES,
  MAX_CONTEXT_FILE_SOURCE_BYTES,
  utf8ByteLength,
} from './context-limits.js';
import { contextError } from './context-errors.js';

/**
 * Application-facing access to a gathered PR snapshot. The service knows the
 * V2 context contract, but not prompts, providers, or tool schemas.
 */
export function createContextService({
  bucket,
  github,
  owner,
  repository,
  repositoryFullName,
  repositoryId,
  prNumber,
  expectedHeadSha,
} = {}) {
  let manifestPromise;
  let filesPromise;

  const getManifestRecord = async () => {
    manifestPromise ||= readContextManifest(bucket, repositoryId, prNumber);
    const manifest = await manifestPromise;
    if (!manifest) return { status: 'missing', manifest: null };
    if (expectedHeadSha && manifest.headSha !== expectedHeadSha) {
      return { status: 'stale', manifest };
    }
    return { status: 'available', manifest };
  };

  const getSnapshotState = async () => toSnapshotState(await getManifestRecord());

  const getPrMetadata = async () => {
    const snapshot = await getManifestRecord();
    return {
      ...toSnapshotState(snapshot),
      metadata: snapshot.manifest
        ? toPrMetadata(snapshot.manifest, {
            repositoryFullName,
            owner,
            repository,
            prNumber,
          })
        : null,
    };
  };

  const getFileIndex = async () => {
    const snapshot = await getManifestRecord();
    if (snapshot.status !== 'available') return { ...snapshot, files: [] };
    filesPromise ||= readContextFiles(bucket, repositoryId, prNumber);
    const files = await filesPromise;
    if (!Array.isArray(files)) {
      return { status: 'missing', manifest: snapshot.manifest, files: [] };
    }
    return { status: 'available', manifest: snapshot.manifest, files };
  };

  const listChangedFiles = async ({ pathPrefix, limit = 500 } = {}) => {
    const indexed = await getFileIndex();
    if (indexed.status !== 'available') return { status: indexed.status, files: [] };
    let prefix = null;
    if (pathPrefix != null) {
      try {
        const rawPrefix = String(pathPrefix).replace(/\/+$/, '');
        prefix = rawPrefix ? `${normalizeRepositoryPath(rawPrefix)}/` : null;
      } catch {
        throw contextError('INVALID_PATH', 'The path prefix is not a valid repository path.');
      }
    }
    const maxFiles = Math.min(Math.max(Number(limit) || 500, 1), 500);
    const filtered = prefix
      ? indexed.files.filter((entry) => entry?.path?.startsWith(prefix))
      : indexed.files;
    return {
      status: 'available',
      files: filtered.slice(0, maxFiles).map(toChangedFileDto),
      truncated: filtered.length > maxFiles,
    };
  };

  const getDiff = async (path, { maxBytes = DEFAULT_CONTEXT_DIFF_RESULT_BYTES } = {}) => {
    let normalizedPath;
    try {
      normalizedPath = normalizeRepositoryPath(path);
    } catch {
      return { status: 'invalid_path', path: String(path ?? '') };
    }

    const indexed = await getFileIndex();
    if (indexed.status !== 'available') {
      return { ...toSnapshotState(indexed), path: normalizedPath };
    }
    const file = indexed.files.find((entry) => entry?.path === normalizedPath);
    if (!file) {
      return { status: 'not_found', path: normalizedPath, headSha: indexed.manifest.headSha };
    }
    if (file.diff?.state !== 'available') {
      return {
        status: 'unavailable',
        path: normalizedPath,
        headSha: indexed.manifest.headSha,
        reason: file.diff?.reason || 'patch_unavailable',
      };
    }

    const text = await readContextDiff(bucket, repositoryId, prNumber, file);
    if (text == null) {
      return {
        status: 'unavailable',
        path: normalizedPath,
        headSha: indexed.manifest.headSha,
        reason: 'artifact_missing',
      };
    }
    const bytes = utf8ByteLength(text);
    if (Number.isFinite(maxBytes) && maxBytes >= 0 && bytes > maxBytes) {
      return {
        status: 'available',
        path: normalizedPath,
        headSha: indexed.manifest.headSha,
        bytes,
        diff: null,
        truncated: true,
      };
    }
    return {
      status: 'available',
      path: normalizedPath,
      headSha: indexed.manifest.headSha,
      bytes,
      diff: text,
      truncated: false,
    };
  };

  const getFile = async (
    path,
    { revision = 'head', maxBytes = DEFAULT_CONTEXT_FILE_RESULT_BYTES } = {},
  ) => {
    let normalizedPath;
    try {
      normalizedPath = normalizeRepositoryPath(path);
    } catch {
      throw contextError('INVALID_PATH', 'The file path is not a valid repository-relative path.');
    }
    if (revision !== 'head') {
      throw contextError('INVALID_REVISION', 'Only the pull request head revision is available.');
    }
    if (!github || typeof github.getFileContent !== 'function') {
      throw contextError('SOURCE_UNAVAILABLE', 'Repository source access is not configured.');
    }
    if (!owner || !repository || !expectedHeadSha) {
      throw contextError('SOURCE_UNAVAILABLE', 'The pull request source context is incomplete.');
    }

    let content;
    try {
      content = await github.getFileContent(owner, repository, normalizedPath, expectedHeadSha);
    } catch {
      throw contextError('FILE_NOT_FOUND', 'The requested repository file could not be loaded.');
    }
    const text = String(content ?? '');
    const bytes = utf8ByteLength(text);
    if (bytes > MAX_CONTEXT_FILE_SOURCE_BYTES) {
      throw contextError(
        'FILE_TOO_LARGE',
        'The requested repository file exceeds the source limit.',
        {
          bytes,
          maxBytes: MAX_CONTEXT_FILE_SOURCE_BYTES,
        },
      );
    }
    if (Number.isFinite(maxBytes) && maxBytes >= 0 && bytes > maxBytes) {
      return {
        status: 'available',
        path: normalizedPath,
        revision,
        headSha: expectedHeadSha,
        content: null,
        bytes,
        truncated: true,
      };
    }
    return {
      status: 'available',
      path: normalizedPath,
      revision,
      headSha: expectedHeadSha,
      content: text,
      bytes,
      truncated: false,
    };
  };

  const getFileRange = async (
    path,
    { startLine, endLine, maxBytes = DEFAULT_CONTEXT_FILE_RESULT_BYTES } = {},
  ) => {
    if (
      !Number.isInteger(startLine) ||
      !Number.isInteger(endLine) ||
      startLine < 1 ||
      endLine < startLine ||
      endLine - startLine + 1 > MAX_CONTEXT_FILE_RANGE_LINES
    ) {
      throw contextError('INVALID_LINE_RANGE', 'The requested line range is invalid or too large.');
    }
    const source = await getFile(path, { maxBytes: Number.POSITIVE_INFINITY });
    const lines = source.content.split(/\r?\n/);
    const selected = lines.slice(startLine - 1, endLine);
    const content = selected.map((line, index) => `${startLine + index} | ${line}`).join('\n');
    const bytes = utf8ByteLength(content);
    if (Number.isFinite(maxBytes) && maxBytes >= 0 && bytes > maxBytes) {
      return {
        ...source,
        startLine,
        endLine,
        content: null,
        bytes,
        returnedLines: selected.length,
        truncated: true,
      };
    }
    return {
      ...source,
      startLine,
      endLine: Math.min(endLine, lines.length),
      content,
      bytes,
      returnedLines: selected.length,
      totalLines: lines.length,
      truncated: false,
    };
  };

  const getDescription = async ({ maxBytes = 50 * 1024 } = {}) => {
    const snapshot = await getManifestRecord();
    if (snapshot.status !== 'available') return toSnapshotState(snapshot);
    const body = await readContextSlice(bucket, repositoryId, prNumber, 'description');
    const text = String(body ?? '');
    if (utf8ByteLength(text) > maxBytes) {
      return {
        status: 'available',
        title: snapshot.manifest.title ?? null,
        body: null,
        truncated: true,
      };
    }
    return {
      status: 'available',
      title: snapshot.manifest.title ?? null,
      body: text,
      author: snapshot.manifest.authorLogin ?? null,
      baseSha: snapshot.manifest.baseSha ?? null,
      headSha: snapshot.manifest.headSha,
      truncated: false,
    };
  };

  const getCommits = async ({ limit = 30 } = {}) => {
    const snapshot = await getManifestRecord();
    if (snapshot.status !== 'available') return toSnapshotState(snapshot);
    const commits = await readContextSlice(bucket, repositoryId, prNumber, 'commits');
    const values = Array.isArray(commits) ? commits : [];
    const maxCommits = Math.min(Math.max(Number(limit) || 30, 1), 30);
    return {
      status: 'available',
      commits: values.slice(0, maxCommits),
      total: values.length,
      truncated: values.length > maxCommits,
      headSha: snapshot.manifest.headSha,
    };
  };

  const getComments = async ({ path, limit = 50 } = {}) => {
    const snapshot = await getManifestRecord();
    if (snapshot.status !== 'available') return toSnapshotState(snapshot);
    const comments = await readContextSlice(bucket, repositoryId, prNumber, 'comments');
    const groups = [comments?.issue, comments?.review].filter(Array.isArray).flat();
    let filtered = groups;
    if (path != null) {
      let normalizedPath;
      try {
        normalizedPath = normalizeRepositoryPath(path);
      } catch {
        throw contextError('INVALID_PATH', 'The comment path is not a valid repository path.');
      }
      filtered = groups.filter((comment) => comment?.path === normalizedPath);
    }
    const maxComments = Math.min(Math.max(Number(limit) || 50, 1), 50);
    return {
      status: 'available',
      comments: filtered.slice(0, maxComments),
      total: filtered.length,
      truncated: filtered.length > maxComments,
      headSha: snapshot.manifest.headSha,
    };
  };

  /**
   * Produces a bounded, aggregate unified-diff-shaped view for prompt builders.
   * Storage remains per-file and no stored artifact is truncated.
   * Files that do not fit are omitted as whole artifacts and reported.
   */
  const getCombinedDiff = async ({ maxBytes } = {}) => {
    const indexed = await getFileIndex();
    if (indexed.status !== 'available') {
      return { ...toSnapshotState(indexed), diff: '', truncated: false, omittedPaths: [] };
    }
    const parts = [];
    const omittedPaths = [];
    let usedBytes = 0;
    for (const file of indexed.files) {
      if (file?.diff?.state !== 'available') continue;
      const result = await getDiff(file.path, { maxBytes: Number.POSITIVE_INFINITY });
      if (result.status !== 'available' || !result.diff) {
        omittedPaths.push(file.path);
        continue;
      }
      const oldPath = file.status === 'added' ? '/dev/null' : `a/${file.previousPath || file.path}`;
      const newPath = file.status === 'removed' ? '/dev/null' : `b/${file.path}`;
      const patch = [
        `diff --git a/${file.path} b/${file.path}`,
        `--- ${oldPath}`,
        `+++ ${newPath}`,
        result.diff,
      ].join('\n');
      const patchBytes = utf8ByteLength(patch) + (parts.length ? 1 : 0);
      if (Number.isFinite(maxBytes) && usedBytes + patchBytes > maxBytes) {
        omittedPaths.push(file.path);
        continue;
      }
      parts.push(patch);
      usedBytes += patchBytes;
    }
    return {
      status: 'available',
      headSha: indexed.manifest.headSha,
      diff: parts.join('\n'),
      bytes: usedBytes,
      truncated: omittedPaths.length > 0,
      omittedPaths,
    };
  };

  const getSnapshotSlices = async ({ maxDiffBytes } = {}) => {
    const snapshot = await getManifestRecord();
    if (snapshot.status !== 'available') {
      return { ...toSnapshotState(snapshot), metadata: null, slices: null };
    }
    const [description, commits, comments, combined] = await Promise.all([
      readContextSlice(bucket, repositoryId, prNumber, 'description'),
      readContextSlice(bucket, repositoryId, prNumber, 'commits'),
      readContextSlice(bucket, repositoryId, prNumber, 'comments'),
      getCombinedDiff({ maxBytes: maxDiffBytes }),
    ]);
    const indexed = await getFileIndex();
    return {
      status: 'available',
      metadata: toPrMetadata(snapshot.manifest, {
        repositoryFullName,
        owner,
        repository,
        prNumber,
      }),
      gatheredAt: snapshot.manifest.gatheredAt ?? null,
      slices: {
        description,
        commits,
        comments,
        files: indexed.files.map(toChangedFileDto),
        diff: combined.diff,
      },
      diff: combined,
    };
  };

  return {
    getSnapshotState,
    getPrMetadata,
    listChangedFiles,
    getDiff,
    getFile,
    getFileRange,
    getDescription,
    getCommits,
    getComments,
    getCombinedDiff,
    getSnapshotSlices,
  };
}

function toSnapshotState(snapshot) {
  return {
    status: snapshot.status,
    headSha: snapshot.manifest?.headSha ?? null,
    gatheredAt: snapshot.manifest?.gatheredAt ?? null,
  };
}

function toPrMetadata(manifest, { repositoryFullName, owner, repository, prNumber }) {
  const aggregates = manifest.aggregates || {};
  const counts = manifest.counts || {};
  return {
    repository: repositoryFullName || (owner && repository ? `${owner}/${repository}` : null),
    pullRequest: prNumber,
    title: manifest.title ?? null,
    author: manifest.authorLogin ?? null,
    baseSha: manifest.baseSha ?? null,
    headSha: manifest.headSha,
    changedFiles: Number(counts.files ?? aggregates.changedFiles) || 0,
    additions: Number(aggregates.additions) || 0,
    deletions: Number(aggregates.deletions) || 0,
  };
}

function toChangedFileDto(file) {
  return {
    path: file.path,
    status: file.status || 'modified',
    additions: Number(file.additions) || 0,
    deletions: Number(file.deletions) || 0,
    binary: Boolean(file.binary),
  };
}
