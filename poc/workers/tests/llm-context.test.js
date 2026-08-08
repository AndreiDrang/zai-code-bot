import { describe, expect, it } from 'vitest';
import { buildContextBlock } from '../shared/llm-context.js';

describe('buildContextBlock (review layout)', () => {
  const slices = {
    diff: 'diff --git a/f b/f\n+hello\n-world',
    description: 'Adds a greeting feature.',
    files: [
      { filename: 'src/greet.js', status: 'added', additions: 3, deletions: 0 },
      { filename: 'README.md', status: 'modified', additions: 1, deletions: 1 },
    ],
    commits: [
      {
        sha: 'aaaa1111bbbb2222',
        title: 'Add greet',
        message: 'Add greet\n\nBody',
        author: 'Ann',
        date: '2024-01-01',
      },
      { sha: 'cccc3333', title: 'Docs', message: 'Docs', author: 'Bo', date: '2024-01-02' },
    ],
    comments: {
      issue: [{ user: 'rev1', body: 'Looks good', created_at: 't', updated_at: 't' }],
      review: [{ user: 'rev2', body: 'nit here', path: 'src/greet.js', line: 2, updated_at: 't' }],
    },
  };

  it('renders all 5 slices plus a meta header for review', () => {
    const block = buildContextBlock({
      slices,
      command: 'review',
      meta: { title: 'Add greeting', author: 'author' },
    });
    expect(block).toContain('# Add greeting');
    expect(block).toContain('by @author');
    expect(block).toContain('## Description');
    expect(block).toContain('Adds a greeting feature.');
    expect(block).toContain('## Commits (2)');
    expect(block).toContain('`aaaa111` Add greet — Ann');
    expect(block).toContain('## Conversation');
    expect(block).toContain('### Issue comments (1)');
    expect(block).toContain('**@rev1**: Looks good');
    expect(block).toContain('### Review comments (1)');
    expect(block).toContain('**@rev2** on `src/greet.js`:2: nit here');
    expect(block).toContain('## Changed files (2)');
    expect(block).toContain('src/greet.js');
    expect(block).toContain('## Diff');
    expect(block).toContain('```diff');
    expect(block).toContain('+hello');
  });

  it('never throws on missing/empty slices — yields a diff-only block', () => {
    const block = buildContextBlock({
      slices: { diff: 'only diff' },
      command: 'review',
    });
    expect(block).toContain('## Diff');
    expect(block).not.toContain('## Description');
    expect(block).not.toContain('## Commits');
    expect(block).not.toContain('## Conversation');
    expect(block).not.toContain('## Changed files');
  });

  it('returns an empty-ish block when no slices are present', () => {
    const block = buildContextBlock({ slices: {}, command: 'review' });
    expect(block.trim()).toBe('');
  });

  it('bounds the diff to absorb the remaining budget after secondary slices', () => {
    const big = '+x\n'.repeat(100000); // ~400k chars
    const block = buildContextBlock({ slices: { diff: big }, command: 'review' }, undefined);
    // The builder default budget is 200000 — the diff must not blow past it.
    expect(block.length).toBeLessThan(200000);
  });

  it('truncates oversized slices with an ellipsis marker', () => {
    const longDesc = 'D'.repeat(10000);
    const block = buildContextBlock({
      slices: { diff: 'd', description: longDesc },
      command: 'review',
      budgetBytes: 200000,
    });
    // descriptionCap = min(4000, 5% of 200000=10000) = 4000
    expect(block).toContain('(truncated)');
    expect(block).not.toContain('D'.repeat(10000));
  });

  it('throws for an unknown command (layout must be declared)', () => {
    expect(() => buildContextBlock({ slices: {}, command: 'nope' })).toThrow(
      /no layout for command "nope"/,
    );
  });

  it('renders a short SHA (7 chars) for commits', () => {
    const block = buildContextBlock({
      slices: { commits: [{ sha: '0123456789abcdef', title: 'x' }] },
      command: 'review',
    });
    expect(block).toContain('`0123456`');
  });
});
