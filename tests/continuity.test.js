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
    expect(CONTINUITY_MARKER).toBe('<!-- zai-continuity:');
  });

  test('CONTINUITY_MARKER_END is defined', () => {
    expect(CONTINUITY_MARKER_END).toBe(' -->');
  });

  test('STATE_VERSION is 1', () => {
    expect(STATE_VERSION).toBe(1);
  });

  test('MAX_STATE_SIZE is 2048', () => {
    expect(MAX_STATE_SIZE).toBe(2048);
  });
});

describe('encodeState', () => {
  test('encodes simple state object', () => {
    const state = { key: 'value' };
    const encoded = encodeState(state);
    
    expect(typeof encoded === 'string').toBeTruthy();
    expect(encoded.length > 0).toBeTruthy();
  });

  test('includes version in encoded state', () => {
    const state = { data: 'test' };
    const encoded = encodeState(state);
    const decoded = decodeState(encoded);
    
    expect(decoded.v).toBe(STATE_VERSION);
    expect(decoded.data).toBe('test');
  });

  test('throws when state exceeds size limit', () => {
    const largeState = { data: 'x'.repeat(MAX_STATE_SIZE) };
    
    expect(() => 
      () => encodeState(largeState),
      /exceeds limit/
    );
  });

  test('produces URL-safe base64', () => {
    const state = { test: 'value' };
    const encoded = encodeState(state);
    
    expect(encoded).not.toContain('+');
    expect(encoded).not.toContain('/');
    expect(encoded).not.toContain('=');
  });
});

describe('decodeState', () => {
  test('decodes valid encoded state', () => {
    const state = { key: 'value', count: 42 };
    const encoded = encodeState(state);
    const decoded = decodeState(encoded);
    
    expect(decoded).toEqual({ v: STATE_VERSION, ...state });
  });

  test('returns null for null input', () => {
    expect(decodeState(null)).toBe(null);
  });

  test('returns null for undefined input', () => {
    expect(decodeState(undefined)).toBe(null);
  });

  test('returns null for empty string', () => {
    expect(decodeState('')).toBe(null);
  });

  test('returns null for invalid base64', () => {
    expect(decodeState('not-valid-base64!!!')).toBe(null);
  });

  test('returns null for invalid JSON', () => {
    const validBase64 = Buffer.from('not-json').toString('base64url');
    expect(decodeState(validBase64)).toBe(null);
  });

  test('handles legacy state without version', () => {
    const legacyJson = JSON.stringify({ oldKey: 'oldValue' });
    const legacyEncoded = Buffer.from(legacyJson, 'utf8').toString('base64url');
    const decoded = decodeState(legacyEncoded);
    
    expect(decoded.oldKey).toBe('oldValue');
  });

  test('handles standard base64 input', () => {
    const state = { test: 'data' };
    const standardBase64 = Buffer.from(JSON.stringify(state)).toString('base64');
    const decoded = decodeState(standardBase64);
    
    expect(decoded.test).toBe('data');
  });
});

describe('extractStateFromComment', () => {
  test('extracts state from comment with marker', () => {
    const state = { conversationId: 'abc123' };
    const encoded = encodeState(state);
    const commentBody = `Some content\n\n${CONTINUITY_MARKER} ${encoded}${CONTINUITY_MARKER_END}\n\nMore content`;
    
    const extracted = extractStateFromComment(commentBody);
    
    expect(extracted.conversationId).toBe('abc123');
  });

  test('returns null when no marker present', () => {
    const result = extractStateFromComment('Just a regular comment');
    expect(result).toBe(null);
  });

  test('returns null for null body', () => {
    expect(extractStateFromComment(null)).toBe(null);
  });

  test('returns null for empty string', () => {
    expect(extractStateFromComment('')).toBe(null);
  });

  test('returns null for incomplete marker', () => {
    const result = extractStateFromComment('Start <!-- zai-continuity: incomplete');
    expect(result).toBe(null);
  });

  test('returns null for corrupted state in marker', () => {
    const commentBody = `${CONTINUITY_MARKER} invalid-base64${CONTINUITY_MARKER_END}`;
    const result = extractStateFromComment(commentBody);
    expect(result).toBe(null);
  });
});

describe('createCommentWithState', () => {
  test('adds state marker to content', () => {
    const content = 'Main comment content';
    const state = { id: 'test123' };
    
    const result = createCommentWithState(content, state);
    
    expect(result.includes(content)).toBe(true);
    expect(result.includes(CONTINUITY_MARKER)).toBe(true);
    expect(result.includes(CONTINUITY_MARKER_END)).toBe(true);
  });

  test('returns original content when state is empty', () => {
    const content = 'Just content';
    const result = createCommentWithState(content, {});
    expect(result).toBe(content);
  });

  test('returns original content when state is null', () => {
    const content = 'Just content';
    const result = createCommentWithState(content, null);
    expect(result).toBe(content);
  });

  test('returns original content when encoding fails', () => {
    const content = 'Content';
    const state = { data: 'x'.repeat(MAX_STATE_SIZE * 2) };
    const result = createCommentWithState(content, state);
    expect(result).toBe(content);
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
    expect(result.id).toBe(2);
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
    expect(result).toBe(null);
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
    expect(result.threadId).toBe('thread-456');
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
    expect(result).toBe(null);
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
    expect(result).toBe(null);
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

    expect(createCalled).toBe(true);
    expect(result.action).toBe('created');
    expect(result.comment.body.includes('zai-continuity')).toBe(true);
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

    expect(result.action).toBe('updated');
    expect(result.comment.body.includes(CONTINUITY_MARKER)).toBe(true);
  });

  test('throws when creating without content', async () => {
    const mockOctokit = {
      rest: {
        issues: {
          listComments: async () => ({ data: [] }),
        },
      },
    };

    await expect(
      saveContinuityState(mockOctokit, 'owner', 'repo', 1, { data: 'test' })
    ).rejects.toThrow('Cannot create comment without content');
  });
});

describe('mergeState', () => {
  test('merges updates into empty state', () => {
    const result = mergeState(null, { key: 'value' });
    expect(result).toEqual({ key: 'value' });
  });

  test('merges updates into existing state', () => {
    const current = { existing: 'data', keep: 'this' };
    const updates = { existing: 'updated', new: 'field' };
    
    const result = mergeState(current, updates);
    
    expect(result.existing).toBe('updated');
    expect(result.keep).toBe('this');
    expect(result.new).toBe('field');
  });

  test('returns updates when current is undefined', () => {
    const result = mergeState(undefined, { key: 'value' });
    expect(result).toEqual({ key: 'value' });
  });
});
