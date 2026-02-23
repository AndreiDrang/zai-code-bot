const { test, describe } = require('node:test');
const assert = require('node:assert');
const {
  CONTINUITY_MARKER,
  CONTINUITY_MARKER_END,
  STATE_VERSION,
  MAX_STATE_SIZE,
  encodeState,
  decodeState,
  extractStateFromComment,
  createCommentWithState,
  findStateComment,
  loadContinuityState,
  saveContinuityState,
  mergeState,
} = require('../src/lib/continuity.js');

describe('Constants', () => {
  test('CONTINUITY_MARKER is defined', () => {
    assert.strictEqual(CONTINUITY_MARKER, '<!-- zai-continuity:');
  });

  test('CONTINUITY_MARKER_END is defined', () => {
    assert.strictEqual(CONTINUITY_MARKER_END, ' -->');
  });

  test('STATE_VERSION is 1', () => {
    assert.strictEqual(STATE_VERSION, 1);
  });

  test('MAX_STATE_SIZE is 2048', () => {
    assert.strictEqual(MAX_STATE_SIZE, 2048);
  });
});

describe('encodeState', () => {
  test('encodes simple state object', () => {
    const state = { key: 'value' };
    const encoded = encodeState(state);
    
    assert.ok(typeof encoded === 'string');
    assert.ok(encoded.length > 0);
  });

  test('includes version in encoded state', () => {
    const state = { data: 'test' };
    const encoded = encodeState(state);
    const decoded = decodeState(encoded);
    
    assert.strictEqual(decoded.v, STATE_VERSION);
    assert.strictEqual(decoded.data, 'test');
  });

  test('throws when state exceeds size limit', () => {
    const largeState = { data: 'x'.repeat(MAX_STATE_SIZE) };
    
    assert.throws(
      () => encodeState(largeState),
      /exceeds limit/
    );
  });

  test('produces URL-safe base64', () => {
    const state = { test: 'value' };
    const encoded = encodeState(state);
    
    assert.ok(!encoded.includes('+'));
    assert.ok(!encoded.includes('/'));
    assert.ok(!encoded.includes('='));
  });
});

describe('decodeState', () => {
  test('decodes valid encoded state', () => {
    const state = { key: 'value', count: 42 };
    const encoded = encodeState(state);
    const decoded = decodeState(encoded);
    
    assert.deepStrictEqual(decoded, { v: STATE_VERSION, ...state });
  });

  test('returns null for null input', () => {
    assert.strictEqual(decodeState(null), null);
  });

  test('returns null for undefined input', () => {
    assert.strictEqual(decodeState(undefined), null);
  });

  test('returns null for empty string', () => {
    assert.strictEqual(decodeState(''), null);
  });

  test('returns null for invalid base64', () => {
    assert.strictEqual(decodeState('not-valid-base64!!!'), null);
  });

  test('returns null for invalid JSON', () => {
    const validBase64 = Buffer.from('not-json').toString('base64url');
    assert.strictEqual(decodeState(validBase64), null);
  });

  test('handles legacy state without version', () => {
    const legacyJson = JSON.stringify({ oldKey: 'oldValue' });
    const legacyEncoded = Buffer.from(legacyJson, 'utf8').toString('base64url');
    const decoded = decodeState(legacyEncoded);
    
    assert.strictEqual(decoded.oldKey, 'oldValue');
  });

  test('handles standard base64 input', () => {
    const state = { test: 'data' };
    const standardBase64 = Buffer.from(JSON.stringify(state)).toString('base64');
    const decoded = decodeState(standardBase64);
    
    assert.strictEqual(decoded.test, 'data');
  });
});

describe('extractStateFromComment', () => {
  test('extracts state from comment with marker', () => {
    const state = { conversationId: 'abc123' };
    const encoded = encodeState(state);
    const commentBody = `Some content\n\n${CONTINUITY_MARKER} ${encoded}${CONTINUITY_MARKER_END}\n\nMore content`;
    
    const extracted = extractStateFromComment(commentBody);
    
    assert.strictEqual(extracted.conversationId, 'abc123');
  });

  test('returns null when no marker present', () => {
    const result = extractStateFromComment('Just a regular comment');
    assert.strictEqual(result, null);
  });

  test('returns null for null body', () => {
    assert.strictEqual(extractStateFromComment(null), null);
  });

  test('returns null for empty string', () => {
    assert.strictEqual(extractStateFromComment(''), null);
  });

  test('returns null for incomplete marker', () => {
    const result = extractStateFromComment('Start <!-- zai-continuity: incomplete');
    assert.strictEqual(result, null);
  });

  test('returns null for corrupted state in marker', () => {
    const commentBody = `${CONTINUITY_MARKER} invalid-base64${CONTINUITY_MARKER_END}`;
    const result = extractStateFromComment(commentBody);
    assert.strictEqual(result, null);
  });
});

describe('createCommentWithState', () => {
  test('adds state marker to content', () => {
    const content = 'Main comment content';
    const state = { id: 'test123' };
    
    const result = createCommentWithState(content, state);
    
    assert.ok(result.includes(content));
    assert.ok(result.includes(CONTINUITY_MARKER));
    assert.ok(result.includes(CONTINUITY_MARKER_END));
  });

  test('returns original content when state is empty', () => {
    const content = 'Just content';
    const result = createCommentWithState(content, {});
    assert.strictEqual(result, content);
  });

  test('returns original content when state is null', () => {
    const content = 'Just content';
    const result = createCommentWithState(content, null);
    assert.strictEqual(result, content);
  });

  test('returns original content when encoding fails', () => {
    const content = 'Content';
    const state = { data: 'x'.repeat(MAX_STATE_SIZE * 2) };
    const result = createCommentWithState(content, state);
    assert.strictEqual(result, content);
  });
});

describe('findStateComment', () => {
  test('finds comment with continuity marker', async () => {
    const mockOctokit = {
      rest: {
        issues: {
          listComments: async () => ({
            data: [
              { id: 1, body: 'Regular comment' },
              { id: 2, body: `${CONTINUITY_MARKER} abc123${CONTINUITY_MARKER_END}` },
            ],
          }),
        },
      },
    };

    const result = await findStateComment(mockOctokit, 'owner', 'repo', 1);
    assert.strictEqual(result.id, 2);
  });

  test('returns null when no continuity comment', async () => {
    const mockOctokit = {
      rest: {
        issues: {
          listComments: async () => ({
            data: [
              { id: 1, body: 'Comment without marker' },
            ],
          }),
        },
      },
    };

    const result = await findStateComment(mockOctokit, 'owner', 'repo', 1);
    assert.strictEqual(result, null);
  });
});

describe('loadContinuityState', () => {
  test('loads state from existing comment', async () => {
    const state = { threadId: 'thread-456' };
    const encoded = encodeState(state);
    
    const mockOctokit = {
      rest: {
        issues: {
          listComments: async () => ({
            data: [
              { id: 1, body: `${CONTINUITY_MARKER} ${encoded}${CONTINUITY_MARKER_END}` },
            ],
          }),
        },
      },
    };

    const result = await loadContinuityState(mockOctokit, 'owner', 'repo', 1);
    assert.strictEqual(result.threadId, 'thread-456');
  });

  test('returns null when no comment found', async () => {
    const mockOctokit = {
      rest: {
        issues: {
          listComments: async () => ({ data: [] }),
        },
      },
    };

    const result = await loadContinuityState(mockOctokit, 'owner', 'repo', 1);
    assert.strictEqual(result, null);
  });

  test('returns null when comment has no marker', async () => {
    const mockOctokit = {
      rest: {
        issues: {
          listComments: async () => ({
            data: [
              { id: 1, body: 'Comment without state marker' },
            ],
          }),
        },
      },
    };

    const result = await loadContinuityState(mockOctokit, 'owner', 'repo', 1);
    assert.strictEqual(result, null);
  });
});

describe('saveContinuityState', () => {
  test('creates new comment with state when none exists', async () => {
    let createCalled = false;
    const mockOctokit = {
      rest: {
        issues: {
          listComments: async () => ({ data: [] }),
          createComment: async (params) => {
            createCalled = true;
            return { data: { id: 100, body: params.body } };
          },
        },
      },
    };

    const result = await saveContinuityState(
      mockOctokit, 'owner', 'repo', 1,
      { newState: 'value' },
      { content: 'New comment' }
    );

    assert.strictEqual(createCalled, true);
    assert.strictEqual(result.action, 'created');
    assert.ok(result.comment.body.includes('zai-continuity'));
  });

  test('updates existing comment preserving content', async () => {
    const mockOctokit = {
      rest: {
        issues: {
          listComments: async () => ({
            data: [
              { 
                id: 50, 
                body: `Old comment content\n\n${CONTINUITY_MARKER} old${CONTINUITY_MARKER_END}` 
              },
            ],
          }),
          updateComment: async (params) => ({
            data: { id: params.comment_id, body: params.body },
          }),
        },
      },
    };

    const result = await saveContinuityState(
      mockOctokit, 'owner', 'repo', 1,
      { newState: 'new' }
    );

    assert.strictEqual(result.action, 'updated');
    assert.ok(result.comment.body.includes(CONTINUITY_MARKER));
  });

  test('throws when creating without content', async () => {
    const mockOctokit = {
      rest: {
        issues: {
          listComments: async () => ({ data: [] }),
        },
      },
    };

    await assert.rejects(
      saveContinuityState(mockOctokit, 'owner', 'repo', 1, { data: 'test' }),
      { message: 'Cannot create comment without content' }
    );
  });
});

describe('mergeState', () => {
  test('merges updates into empty state', () => {
    const result = mergeState(null, { key: 'value' });
    assert.deepStrictEqual(result, { key: 'value' });
  });

  test('merges updates into existing state', () => {
    const current = { existing: 'data', keep: 'this' };
    const updates = { existing: 'updated', new: 'field' };
    
    const result = mergeState(current, updates);
    
    assert.strictEqual(result.existing, 'updated');
    assert.strictEqual(result.keep, 'this');
    assert.strictEqual(result.new, 'field');
  });

  test('returns updates when current is undefined', () => {
    const result = mergeState(undefined, { key: 'value' });
    assert.deepStrictEqual(result, { key: 'value' });
  });
});
