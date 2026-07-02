/**
 * Repository Context Collection
 *
 * Gathers real, observable repository facts (file tree, existing AGENTS.md files,
 * and key file contents) so the AGENTS.md upgrade prompt is grounded in evidence
 * instead of letting the model hallucinate a project from the repo name alone.
 *
 * This module is deliberately self-contained: it talks to Octokit directly and
 * never depends on the scheduled handler, avoiding circular imports.
 */

// Files that are always pulled into context when present (repo-defining metadata).
// These ground the model in the real language/framework/entry points.
const KEY_FILES = [
  'README.md',
  'package.json',
  'package-lock.json',
  'tsconfig.json',
  'pyproject.toml',
  'requirements.txt',
  'Cargo.toml',
  'go.mod',
  'pom.xml',
  'build.gradle',
  'action.yml',
  'action.yaml',
  '.zai-scheduled.yml',
  'Dockerfile',
  'CONTRIBUTING.md',
  'ARCHITECTURE.md',
  '.github/copilot-instructions.md',
];

// Glob directory patterns excluded from context by default (vendored/generated noise).
const DEFAULT_EXCLUDE_PATHS = [
  'node_modules/**',
  '.git/**',
  'dist/**',
  'build/**',
  'coverage/**',
  '.next/**',
  '.nuxt/**',
  '.cache/**',
  '.turbo/**',
  '__pycache__/**',
  '.venv/**',
  'vendor/**',
  '*.lock',
  '*.min.js',
  '*.min.css',
  'package-lock.json',
  'yarn.lock',
  'pnpm-lock.yaml',
];

// Default context budget (characters). Generous enough for mid-size repos while
// staying well under typical model context windows after the gist prompt is added.
const DEFAULT_MAX_CONTEXT_CHARS = 120000;

// Per-file content cap. Large files are head-truncated to this many characters.
const DEFAULT_MAX_FILE_CHARS = 12000;

// Maximum number of content fetches we will issue (protects the API rate limit).
const DEFAULT_MAX_FILES_TO_FETCH = 40;

/**
 * Convert a glob pattern (supporting ** and *) into a RegExp.
 * @param {string} pattern - Glob pattern
 * @returns {RegExp} Matching regular expression
 */
function globToRegExp(pattern) {
  // Anchor and escape, then translate glob tokens.
  let re = '^';
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === '*') {
      if (pattern[i + 1] === '*') {
        // '**' matches across directory separators.
        // If it follows a literal '/', make that '/' optional so that
        // 'node_modules/**' matches both 'node_modules' and 'node_modules/x'.
        if (re.endsWith('/')) {
          re = re.slice(0, -1) + '(?:/.*)?';
        } else {
          re += '.*';
        }
        i++; // consume second '*'
        // swallow an optional trailing slash so 'a/**/' also works
        if (pattern[i + 1] === '/') i++;
      } else {
        // '*' matches within a path segment
        re += '[^/]*';
      }
    } else if ('.+?^${}()|[]\\'.includes(c)) {
      re += '\\' + c;
    } else {
      re += c;
    }
  }
  re += '$';
  return new RegExp(re);
}

/**
 * Test whether a repo-relative path is excluded by any exclude glob.
 * @param {string} path - Repo-relative path
 * @param {RegExp[]} excludeRegexes - Compiled exclude patterns
 * @returns {boolean}
 */
function isExcluded(path, excludeRegexes) {
  return excludeRegexes.some(re => re.test(path));
}

/**
 * Normalize a user-supplied path into a directory prefix form.
 * '.' and '' -> '' (repo root). Trailing slash stripped.
 * @param {string} p
 * @returns {string}
 */
function normalizePathPrefix(p) {
  if (!p) return '';
  let s = String(p).trim().replace(/\\/g, '/').replace(/\/+$/, '');
  if (s === '.' ) return '';
  return s;
}

/**
 * Returns true if `path` lives under one of the given context/target prefixes.
 * Empty prefix list means "everywhere" (no restriction).
 * @param {string} path
 * @param {string[]} prefixes - normalized prefixes
 * @returns {boolean}
 */
function isUnderPrefix(path, prefixes) {
  if (!prefixes || prefixes.length === 0) return true;
  const norm = path.replace(/\\/g, '/');
  return prefixes.some(prefix => {
    if (!prefix) return true;
    return norm === prefix || norm.startsWith(prefix + '/');
  });
}

/**
 * Fetch a single file's text content from the repository.
 * Returns null for missing files (404) instead of throwing.
 * @param {Object} octokit
 * @param {string} owner
 * @param {string} repo
 * @param {string} path
 * @param {string} ref
 * @returns {Promise<string|null>}
 */
async function fetchFile(octokit, owner, repo, path, ref) {
  try {
    const { data } = await octokit.rest.repos.getContent({ owner, repo, path, ref });
    // Directory entries (array) or non-text entries have no content.
    if (!data || data.type !== 'file' || typeof data.content !== 'string') {
      return null;
    }
    return Buffer.from(data.content, 'base64').toString('utf8');
  } catch (error) {
    if (error.status === 404) return null;
    throw error;
  }
}

/**
 * Collect grounded repository context for AGENTS.md generation.
 *
 * @param {Object} params
 * @param {Object} params.octokit - GitHub Octokit instance
 * @param {string} params.owner - Repository owner
 * @param {string} params.repo - Repository name
 * @param {string} params.branch - Branch/ref to read from
 * @param {string[]} [params.contextPaths] - Limit analysis (file tree + contents) to these paths. Default: whole repo.
 * @param {string[]} [params.targetPaths] - Limit where AGENTS.md may be written. Default: anywhere. (Root AGENTS.md always allowed.)
 * @param {string[]} [params.excludePaths] - Globs to ignore. Merged with sensible defaults.
 * @param {number} [params.maxContextChars] - Total char budget for file contents.
 * @param {number} [params.maxFileChars] - Per-file content cap.
 * @param {number} [params.maxFilesToFetch] - Hard cap on content fetches.
 * @param {Object} [params.logger]
 * @returns {Promise<Object>} Collected context object
 */
async function collectRepositoryContext(params) {
  const {
    octokit,
    owner,
    repo,
    branch,
  } = params;

  const logger = params.logger || console;
  const contextPaths = (params.contextPaths || []).map(normalizePathPrefix).filter(Boolean);
  const targetPaths = (params.targetPaths || []).map(normalizePathPrefix).filter(Boolean);
  const excludePaths = [
    ...DEFAULT_EXCLUDE_PATHS,
    ...(params.excludePaths || []),
  ];
  const maxContextChars = params.maxContextChars || DEFAULT_MAX_CONTEXT_CHARS;
  const maxFileChars = params.maxFileChars || DEFAULT_MAX_FILE_CHARS;
  const maxFilesToFetch = params.maxFilesToFetch || DEFAULT_MAX_FILES_TO_FETCH;

  const excludeRegexes = excludePaths.map(globToRegExp);

  // ---- Step 1: full recursive file tree ----
  let tree = [];
  let truncated = false;
  try {
    const { data } = await octokit.rest.git.getTree({
      owner,
      repo,
      tree_sha: branch,
      recursive: 'true',
    });
    tree = Array.isArray(data.tree) ? data.tree : [];
    truncated = data.truncated === true;
  } catch (error) {
    logger.warn?.({ error: error.message }, 'Failed to fetch repository tree');
    // Treat as empty tree rather than crashing; existing-files detection still
    // works via the targeted key-file fetches below.
    tree = [];
  }

  if (truncated) {
    logger.warn?.('Repository tree is truncated; context may be incomplete');
  }

  // Build a flat list of repo-relative file paths (blobs only), respecting excludes.
  const allFiles = tree
    .filter(entry => entry.type === 'blob' && entry.path)
    .map(entry => entry.path)
    .filter(p => !isExcluded(p, excludeRegexes));

  // Detect existing AGENTS.md files (auto-discovery). Root + any nested.
  const existingAgentsFiles = allFiles.filter(
    p => p === 'AGENTS.md' || p.endsWith('/AGENTS.md')
  );

  // ---- Step 2: select files whose CONTENT to fetch ----
  const contextScopedFiles = contextPaths.length
    ? allFiles.filter(p => isUnderPrefix(p, contextPaths))
    : allFiles;

  // Priority order for content fetching: existing AGENTS.md > key files > dir hints.
  const wantedSet = new Set();
  for (const p of existingAgentsFiles) wantedSet.add(p);
  for (const kf of KEY_FILES) {
    if (contextScopedFiles.includes(kf) || allFiles.includes(kf)) wantedSet.add(kf);
  }
  // Pull a few representative source files per context path so the model sees real code.
  // Limit to avoid rate-limit pressure; prefer small/typical entry files.
  const codeLike = contextScopedFiles.filter(p =>
    /\.(js|mjs|cjs|ts|tsx|jsx|py|go|rs|java|rb|php|cs|sh)$/i.test(p)
  );
  for (const p of codeLike) {
    wantedSet.add(p);
    if (wantedSet.size >= maxFilesToFetch) break;
  }

  // Convert to ordered array, then enforce the fetch cap.
  let filesToFetch = [...wantedSet];
  if (filesToFetch.length > maxFilesToFetch) {
    filesToFetch = filesToFetch.slice(0, maxFilesToFetch);
  }

  // ---- Step 3: fetch contents within the char budget ----
  const fileContents = {};
  let usedChars = 0;

  for (const path of filesToFetch) {
    if (usedChars >= maxContextChars) {
      logger.info?.({ path }, 'Context char budget reached, skipping remaining file fetches');
      break;
    }
    let content;
    try {
      content = await fetchFile(octokit, owner, repo, path, branch);
    } catch (error) {
      logger.warn?.({ error: error.message, path }, 'Failed to fetch file content for context');
      continue;
    }
    if (content === null || content === undefined) continue;

    let capped = content;
    if (capped.length > maxFileChars) {
      capped = capped.slice(0, maxFileChars) + '\n... [truncated]';
    }
    if (usedChars + capped.length > maxContextChars) {
      // Fill whatever budget remains for this file, then stop.
      const remaining = maxContextChars - usedChars;
      if (remaining <= 0) break;
      capped = capped.slice(0, remaining) + '\n... [budget limit]';
    }
    fileContents[path] = capped;
    usedChars += capped.length;
  }

  const collected = {
    owner,
    repo,
    branch,
    truncated,
    totalFiles: allFiles.length,
    tree: allFiles,                       // flat blob path list (post-exclude)
    existingAgentsFiles,                  // auto-discovered
    fileContents,                         // path -> text (budgeted)
    contextPaths,                         // normalized
    targetPaths,                          // normalized
    excludePaths,                         // merged + normalized (raw globs)
    contentCharCount: usedChars,
    filesFetched: Object.keys(fileContents).length,
  };

  logger.info?.(
    {
      totalFiles: collected.totalFiles,
      existingAgents: collected.existingAgentsFiles.length,
      filesFetched: collected.filesFetched,
      chars: usedChars,
      truncated,
    },
    'Repository context collected'
  );

  return collected;
}

/**
 * Render collected context into a compact, deterministic text block for the prompt.
 * @param {Object} ctx - Result of collectRepositoryContext
 * @returns {string}
 */
function renderRepositoryContext(ctx) {
  if (!ctx) return '(no repository context available)';

  const lines = [];

  lines.push(`Repository: ${ctx.owner}/${ctx.repo}`);
  lines.push(`Branch: ${ctx.branch}`);
  if (ctx.truncated) {
    lines.push('NOTE: The repository file tree was truncated by the GitHub API. The listing below may be incomplete.');
  }

  lines.push('');
  lines.push('# Existing AGENTS.md files (auto-discovered, do not omit any):');
  if (ctx.existingAgentsFiles.length) {
    for (const f of ctx.existingAgentsFiles) lines.push(`- ${f}`);
  } else {
    lines.push('- (none found)');
  }

  lines.push('');
  lines.push('# Repository file tree (paths only):');
  const treePreview = ctx.tree && ctx.tree.length
    ? ctx.tree
    : [];
  if (treePreview.length) {
    // Cap the tree listing so it cannot blow the budget on its own.
    const cap = 400;
    for (const p of treePreview.slice(0, cap)) lines.push(p);
    if (treePreview.length > cap) {
      lines.push(`... [${treePreview.length - cap} more paths omitted]`);
    }
  } else {
    lines.push('(file tree unavailable)');
  }

  lines.push('');
  lines.push('# Key file contents:');
  const entries = Object.entries(ctx.fileContents || {});
  if (entries.length) {
    for (const [path, content] of entries) {
      lines.push('');
      lines.push(`## ===== ${path} =====`);
      lines.push(content);
      lines.push(`## ===== end ${path} =====`);
    }
  } else {
    lines.push('(no file contents available)');
  }

  if (ctx.targetPaths && ctx.targetPaths.length) {
    lines.push('');
    lines.push('# Write targets are restricted to:');
    lines.push('- AGENTS.md (root, always allowed)');
    for (const t of ctx.targetPaths) lines.push(`- ${t}/AGENTS.md`);
  }

  return lines.join('\n');
}

module.exports = {
  collectRepositoryContext,
  renderRepositoryContext,
  fetchFile,
  globToRegExp,
  isExcluded,
  isUnderPrefix,
  normalizePathPrefix,
  KEY_FILES,
  DEFAULT_EXCLUDE_PATHS,
  DEFAULT_MAX_CONTEXT_CHARS,
  DEFAULT_MAX_FILE_CHARS,
};
