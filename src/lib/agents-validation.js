/**
 * AGENTS.md Output Validation
 *
 * Validates the model-generated AGENTS.md file updates against the collected
 * repository context BEFORE any PR is created. This is the guardrail that
 * prevents hallucinated output (e.g. a fictional Python project for a JS repo)
 * from being committed — the exact failure seen in PR #15.
 *
 * Validation is conservative-by-default and never throws; it returns a
 * structured result separating accepted files from rejected ones, with reasons.
 */

// Regex for path-like tokens. We scan raw content (backticks act as natural
// delimiters since they are outside the character class), so this captures both
// `backtick/path.js` tokens and bare tree-listing entries like '├── main.py'.
const TOKEN_RE = /[A-Za-z0-9._/@-]{1,200}/g;

// Suffix test: looks like a real file extension (letters/digits, length 1-5).
const EXT_RE = /\.[a-z0-9]{1,5}$/i;

// Files referenced in content that we never treat as hallucination evidence:
// very common generic terms that look like paths but usually are not real files.
const GENERIC_TERMS = new Set([
  'AGENTS.md', 'README.md', 'LICENSE', 'CONTRIBUTING.md', 'CHANGELOG.md',
  '.env', '.gitignore',
]);

/**
 * Is this a valid AGENTS.md path? Must be exactly "AGENTS.md" or end with "/AGENTS.md".
 * @param {string} path
 * @returns {boolean}
 */
function isAgentsPath(path) {
  if (typeof path !== 'string') return false;
  return path === 'AGENTS.md' || path.endsWith('/AGENTS.md');
}

/**
 * Extract backtick-quoted path-like tokens from markdown content.
 * @param {string} content
 * @returns {string[]} unique tokens
 */
function extractReferencedPaths(content) {
  if (!content || typeof content !== 'string') return [];
  const found = new Set();
  let match;
  TOKEN_RE.lastIndex = 0;
  while ((match = TOKEN_RE.exec(content)) !== null) {
    const token = match[0];
    if (GENERIC_TERMS.has(token)) continue;
    // Looks path-ish: contains a slash OR has a file-like extension.
    if (token.includes('/') || EXT_RE.test(token)) {
      found.add(token);
    }
  }
  return [...found];
}

/**
 * Check whether a referenced token corresponds to (or is a prefix of) a real path
 * in the collected tree. Tolerates leading "./" and trailing slashes.
 * @param {string} token
 * @param {string[]} tree - repo-relative file paths
 * @returns {boolean}
 */
function referenceExistsInTree(token, tree) {
  if (!tree || tree.length === 0) return true; // cannot disprove -> don't flag
  const norm = token.replace(/^\.\//, '').replace(/\/+$/, '');
  if (!norm) return true;
  // Exact file match, or the token is a directory prefix of a real path.
  if (tree.includes(norm)) return true;
  return tree.some(p => p.startsWith(norm + '/') || p === norm);
}

/**
 * Validate a single generated file entry against context and policy.
 * @param {Object} fileUpdate - { file, newContent, isNew }
 * @param {Object} ctx - collected repository context
 * @param {Object} policy - { targetPaths, allowCreateNew, updateExistingOnly }
 * @returns {{ valid: boolean, reasons: string[] }}
 */
function validateFileEntry(fileUpdate, ctx, policy) {
  const reasons = [];
  const path = fileUpdate?.file;

  // Rule 1: must be an AGENTS.md path.
  if (!isAgentsPath(path)) {
    reasons.push(`path "${path}" is not an AGENTS.md file`);
    return { valid: false, reasons };
  }

  // Rule 2: target-path scoping. Root AGENTS.md is always allowed.
  const isRoot = path === 'AGENTS.md';
  if (!isRoot && policy.targetPaths && policy.targetPaths.length) {
    const allowed = policy.targetPaths.some(prefix => {
      if (!prefix) return true;
      return path.startsWith(prefix + '/');
    });
    if (!allowed) {
      reasons.push(`path "${path}" is outside configured target_paths (${policy.targetPaths.join(', ')})`);
    }
  }

  // Rule 3: update-existing-only mode rejects brand-new child files.
  const existedBefore = ctx?.existingAgentsFiles?.includes(path) ?? false;
  if (policy.updateExistingOnly === true && !isRoot && !existedBefore) {
    reasons.push(`new file "${path}" rejected because update_existing_only is true`);
  }

  // Rule 4: allow_create_new gate.
  if (policy.allowCreateNew === false && !existedBefore && !isRoot) {
    reasons.push(`new file "${path}" rejected because allow_create_new is false`);
  }

  // Rule 5: hallucination check. If content references many file paths that do
  // not exist in the tree, that is strong evidence of fabrication.
  const referenced = extractReferencedPaths(fileUpdate?.newContent || '');
  if (referenced.length) {
    const unknown = referenced.filter(t => !referenceExistsInTree(t, ctx?.tree));
    // Flag when MORE THAN HALF of referenced concrete paths are unknown, OR when
    // several distinct unknown files appear (catches wholesale fabricated trees).
    const threshold = Math.max(3, Math.ceil(referenced.length / 2));
    if (unknown.length >= threshold) {
      reasons.push(
        `content references ${unknown.length} file path(s) not present in the repository ` +
        `(e.g. ${unknown.slice(0, 5).map(t => `\`${t}\``).join(', ')}); likely hallucination`
      );
    }
  }

  return { valid: reasons.length === 0, reasons };
}

/**
 * Validate a full batch of generated file updates.
 *
 * @param {Object} params
 * @param {Array<Object>} params.fileUpdates - [{ file, newContent, changed, isNew }]
 * @param {Object} params.repositoryContext - collected context (see repository-context.js)
 * @param {string[]} [params.targetPaths] - write scope restriction
 * @param {boolean} [params.allowCreateNew=true] - may new child AGENTS.md be proposed
 * @param {boolean} [params.updateExistingOnly=false] - reject new files entirely
 * @param {Object} [params.logger]
 * @returns {{ accepted: Array, rejected: Array<{file, reasons: string[]}>, allRejected: boolean }}
 */
function validateGeneratedAgentFiles(params) {
  const fileUpdates = params.fileUpdates || [];
  const repositoryContext = params.repositoryContext || {};
  const logger = params.logger || console;
  const policy = {
    targetPaths: params.targetPaths || repositoryContext.targetPaths || [],
    allowCreateNew: params.allowCreateNew !== false,
    updateExistingOnly: params.updateExistingOnly === true,
  };

  const accepted = [];
  const rejected = [];

  for (const entry of fileUpdates) {
    // Only validate entries that would actually change something.
    if (entry && entry.changed === false) {
      accepted.push(entry);
      continue;
    }
    const { valid, reasons } = validateFileEntry(entry, repositoryContext, policy);
    if (valid) {
      accepted.push(entry);
    } else {
      rejected.push({ file: entry?.file, reasons });
      logger.warn?.({ file: entry?.file, reasons }, 'Rejected generated AGENTS.md file');
    }
  }

  return {
    accepted,
    rejected,
    allRejected: fileUpdates.length > 0 && accepted.length === 0,
  };
}

module.exports = {
  validateGeneratedAgentFiles,
  validateFileEntry,
  isAgentsPath,
  extractReferencedPaths,
  referenceExistsInTree,
};
