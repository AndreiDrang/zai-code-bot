import { test, describe, expect } from 'vitest';
const {
  validateGeneratedAgentFiles,
  validateFileEntry,
  isAgentsPath,
  extractReferencedPaths,
  referenceExistsInTree,
} = require('../src/lib/agents-validation.js');

describe('isAgentsPath', () => {
  test('accepts root and nested AGENTS.md', () => {
    expect(isAgentsPath('AGENTS.md')).toBe(true);
    expect(isAgentsPath('src/lib/AGENTS.md')).toBe(true);
  });
  test('rejects non-AGENTS paths', () => {
    expect(isAgentsPath('README.md')).toBe(false);
    expect(isAgentsPath('src/AGENTS.md.txt')).toBe(false);
    expect(isAgentsPath('agents.md')).toBe(false); // case-sensitive
    expect(isAgentsPath(null)).toBe(false);
  });
});

describe('extractReferencedPaths', () => {
  test('pulls path-like backtick tokens, skips generics', () => {
    const content = 'Edit `src/index.js` and `main.py`. See `README.md` and `.env`.';
    const refs = extractReferencedPaths(content);
    expect(refs).toContain('src/index.js');
    expect(refs).toContain('main.py');
    expect(refs).not.toContain('README.md');
    expect(refs).not.toContain('.env');
  });
  test('ignores non-path tokens', () => {
    expect(extractReferencedPaths('use `npm` to `run` things')).toEqual([]);
  });
});

describe('referenceExistsInTree', () => {
  const tree = ['src/index.js', 'src/lib/handlers/scheduled.js', 'package.json'];
  test('exact file match', () => {
    expect(referenceExistsInTree('src/index.js', tree)).toBe(true);
  });
  test('directory prefix match', () => {
    expect(referenceExistsInTree('src/lib', tree)).toBe(true);
  });
  test('unknown token fails', () => {
    expect(referenceExistsInTree('main.py', tree)).toBe(false);
  });
  test('empty tree never flags (cannot disprove)', () => {
    expect(referenceExistsInTree('main.py', [])).toBe(true);
  });
});

describe('validateFileEntry', () => {
  const ctx = {
    existingAgentsFiles: ['AGENTS.md', 'src/lib/AGENTS.md'],
    tree: ['AGENTS.md', 'src/lib/AGENTS.md', 'src/index.js', 'package.json', 'action.yml'],
  };

  test('rejects non-AGENTS path', () => {
    const r = validateFileEntry({ file: 'README.md', newContent: 'x' }, ctx, {});
    expect(r.valid).toBe(false);
    expect(r.reasons.join(' ')).toContain('not an AGENTS.md file');
  });

  test('accepts a clean root AGENTS.md update', () => {
    const r = validateFileEntry({
      file: 'AGENTS.md',
      newContent: '# Project\n\nUses `src/index.js` and `package.json`.',
    }, ctx, {});
    expect(r.valid).toBe(true);
  });

  test('flags hallucination when many referenced files do not exist', () => {
    const content = [
      '# AGENTS.md',
      'Entry: `main.py`',
      'Config: `config.py`',
      'Deps: `requirements.txt`',
      'Handlers: `handlers/__init__.py`',
      'Services: `services/client.py`',
      'Utils: `utils/logger.py`',
    ].join('\n');
    const r = validateFileEntry({ file: 'AGENTS.md', newContent: content }, ctx, {});
    expect(r.valid).toBe(false);
    expect(r.reasons.join(' ')).toContain('hallucination');
  });

  test('does not flag when references are real', () => {
    const content = '# AGENTS.md\nUses `src/index.js`, `package.json`, `action.yml`.';
    const r = validateFileEntry({ file: 'AGENTS.md', newContent: content }, ctx, {});
    expect(r.valid).toBe(true);
  });

  test('rejects out-of-scope target_path write', () => {
    const r = validateFileEntry(
      { file: 'tests/AGENTS.md', newContent: 'ok' },
      { ...ctx, tree: [...ctx.tree, 'tests/AGENTS.md'] },
      { targetPaths: ['src/lib'] }
    );
    expect(r.valid).toBe(false);
    expect(r.reasons.join(' ')).toContain('outside configured target_paths');
  });

  test('allows in-scope target_path write', () => {
    const r = validateFileEntry(
      { file: 'src/lib/AGENTS.md', newContent: 'ok' },
      ctx,
      { targetPaths: ['src/lib'] }
    );
    expect(r.valid).toBe(true);
  });

  test('update_existing_only rejects new child file', () => {
    const r = validateFileEntry(
      { file: 'docs/AGENTS.md', newContent: 'new', isNew: true },
      { ...ctx, tree: [...ctx.tree, 'docs/AGENTS.md'] },
      { updateExistingOnly: true }
    );
    expect(r.valid).toBe(false);
    expect(r.reasons.join(' ')).toContain('update_existing_only');
  });

  test('update_existing_only allows existing child file', () => {
    const r = validateFileEntry(
      { file: 'src/lib/AGENTS.md', newContent: 'updated' },
      ctx,
      { updateExistingOnly: true }
    );
    expect(r.valid).toBe(true);
  });

  test('allow_create_new=false rejects new child but root is fine', () => {
    expect(validateFileEntry(
      { file: 'newdir/AGENTS.md', newContent: 'x', isNew: true },
      { ...ctx, tree: [...ctx.tree, 'newdir/AGENTS.md'] },
      { allowCreateNew: false }
    ).valid).toBe(false);
    expect(validateFileEntry(
      { file: 'AGENTS.md', newContent: 'x' },
      ctx,
      { allowCreateNew: false }
    ).valid).toBe(true);
  });
});

describe('validateGeneratedAgentFiles (batch)', () => {
  const ctx = {
    existingAgentsFiles: ['AGENTS.md'],
    tree: ['AGENTS.md', 'src/index.js', 'package.json', 'action.yml'],
  };

  test('splits accepted vs rejected and flags allRejected', () => {
    const fileUpdates = [
      { file: 'AGENTS.md', newContent: '# uses `src/index.js`', changed: true },
      { file: 'main.py', newContent: 'x', changed: true }, // not an AGENTS path
    ];
    const res = validateGeneratedAgentFiles({ fileUpdates, repositoryContext: ctx });
    expect(res.accepted).toHaveLength(1);
    expect(res.rejected).toHaveLength(1);
    expect(res.allRejected).toBe(false);
  });

  test('allRejected true when every entry fails', () => {
    const fileUpdates = [
      { file: 'main.py', newContent: 'x', changed: true },
      { file: 'config.py', newContent: 'y', changed: true },
    ];
    const res = validateGeneratedAgentFiles({ fileUpdates, repositoryContext: ctx });
    expect(res.accepted).toHaveLength(0);
    expect(res.allRejected).toBe(true);
  });

  test('unchanged entries pass through unchanged', () => {
    const fileUpdates = [{ file: 'AGENTS.md', changed: false }];
    const res = validateGeneratedAgentFiles({ fileUpdates, repositoryContext: ctx });
    expect(res.accepted).toHaveLength(1);
    expect(res.allRejected).toBe(false);
  });

  test('PR #15 regression: fabricated Python Telegram bot is rejected', () => {
    // This is exactly the hallucinated content the bot generated for a JS Action.
    const hallucinated = [
      '# AGENTS.md',
      '',
      '`zai-code-bot` is a Telegram bot that proxies to Zalo AI (ZAI).',
      '',
      '```text',
      '.',
      '├── main.py            # Bot entrypoint',
      '├── config.py          # Reads env vars',
      '├── requirements.txt   # Python dependencies',
      '├── handlers/          # Telegram message handlers',
      '├── services/          # ZAI client wrappers',
      '└── keyboards/         # Inline keyboards',
      '```',
    ].join('\n');
    const res = validateGeneratedAgentFiles({
      fileUpdates: [{ file: 'AGENTS.md', newContent: hallucinated, changed: true }],
      repositoryContext: ctx,
    });
    expect(res.rejected).toHaveLength(1);
    expect(res.allRejected).toBe(true);
    expect(res.rejected[0].reasons.join(' ')).toContain('hallucination');
  });

  test('informs allRejected via logger when provided', () => {
    const warns = [];
    const logger = { warn: (msg) => warns.push(msg) };
    validateGeneratedAgentFiles({
      fileUpdates: [{ file: 'main.py', newContent: 'x', changed: true }],
      repositoryContext: ctx,
      logger,
    });
    expect(warns.length).toBeGreaterThan(0);
  });
});
