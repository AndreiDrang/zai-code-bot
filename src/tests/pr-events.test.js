import { describe, expect, it } from 'vitest';

// Pure unit tests for the PR-context event gate.

import {
  isSupportedPullRequestEvent,
  isPrDescriptionEditEvent,
  planDescriptionRefresh,
  extractPullRequestEvent,
} from '../zai-main-worker/src/pr-events.js';

describe('isSupportedPullRequestEvent', () => {
  it('accepts head-producing actions', () => {
    for (const action of ['opened', 'reopened', 'synchronize', 'ready_for_review']) {
      expect(isSupportedPullRequestEvent('pull_request', action)).toBe(true);
    }
  });

  it('rejects events that do not produce new review context', () => {
    expect(isSupportedPullRequestEvent('pull_request', 'edited')).toBe(false);
    expect(isSupportedPullRequestEvent('pull_request', 'closed')).toBe(false);
  });

  it('rejects unsupported actions', () => {
    expect(isSupportedPullRequestEvent('pull_request', 'labeled')).toBe(false);
    expect(isSupportedPullRequestEvent('pull_request', 'assigned')).toBe(false);
  });

  it('rejects non-pull_request events', () => {
    expect(isSupportedPullRequestEvent('issue_comment', 'created')).toBe(false);
    expect(isSupportedPullRequestEvent('pull_request_review_comment', 'created')).toBe(false);
  });
});

describe('isPrDescriptionEditEvent', () => {
  const env = { BOT_ARTIFACTS: {} };
  const bodyEdit = {
    changes: { body: { from: 'old body' } },
    pull_request: { number: 7, body: 'new body' },
    repository: { id: 10 },
  };

  it('accepts a pull_request edited with changes.body', () => {
    expect(isPrDescriptionEditEvent('pull_request', 'edited', bodyEdit, env)).toBe(true);
  });

  it('rejects a title-only edit (no changes.body)', () => {
    expect(
      isPrDescriptionEditEvent(
        'pull_request',
        'edited',
        { changes: { title: { from: 'x' } } },
        env,
      ),
    ).toBe(false);
  });

  it('rejects non-edited actions and non-pull_request events', () => {
    expect(isPrDescriptionEditEvent('pull_request', 'opened', bodyEdit, env)).toBe(false);
    expect(isPrDescriptionEditEvent('issue_comment', 'edited', bodyEdit, env)).toBe(false);
  });

  it('rejects when R2 is not bound', () => {
    expect(isPrDescriptionEditEvent('pull_request', 'edited', bodyEdit, {})).toBe(false);
  });
});

describe('planDescriptionRefresh', () => {
  it('extracts repoId / prNumber / body from the payload (no API call needed)', () => {
    expect(
      planDescriptionRefresh({
        repository: { id: 10 },
        pull_request: { number: 7, body: 'new desc' },
      }),
    ).toEqual({ repoId: 10, prNumber: 7, body: 'new desc' });
  });

  it('coerces a missing body to empty string (cleared description still refreshes)', () => {
    expect(
      planDescriptionRefresh({
        repository: { id: 10 },
        pull_request: { number: 7, body: null },
      }).body,
    ).toBe('');
  });

  it('returns null when repo / PR identity is incomplete', () => {
    expect(planDescriptionRefresh({ repository: { id: 10 } })).toBeNull();
    expect(planDescriptionRefresh({ pull_request: { number: 7, body: 'x' } })).toBeNull();
  });
});

describe('extractPullRequestEvent', () => {
  // Mirrors the real webhook payload shape for PR #43 title edit.
  function basePayload(overrides = {}) {
    return {
      action: 'edited',
      changes: { title: { from: 'Cloudflare migration' } },
      repository: {
        id: 1164298160,
        name: 'zai-code-bot',
        full_name: 'AndreiDrang/zai-code-bot',
        default_branch: 'main',
        owner: { login: 'AndreiDrang' },
      },
      pull_request: {
        number: 43,
        title: 'To cloudflare migration',
        state: 'open',
        head: { sha: '20b7910be777ee55f7ca355cfeabb5167cc1aa39' },
        base: { sha: '8009db78cb47a226dc15626acf3f40f06e047f23' },
        user: { login: 'AndreiDrang' },
      },
      ...overrides,
    };
  }

  it('extracts the NEW title and head SHA from an edited event', () => {
    const event = extractPullRequestEvent(basePayload(), 'delivery-43-edit');
    expect(event).toMatchObject({
      deliveryId: 'delivery-43-edit',
      action: 'edited',
      repositoryId: 1164298160,
      prNumber: 43,
      title: 'To cloudflare migration',
      headSha: '20b7910be777ee55f7ca355cfeabb5167cc1aa39',
      authorLogin: 'AndreiDrang',
      state: 'open',
    });
    expect(event.repository.fullName).toBe('AndreiDrang/zai-code-bot');
  });

  it('uses the explicit action argument over the payload action (webhookData.action wins)', () => {
    const event = extractPullRequestEvent(basePayload(), 'delivery-1', 'synchronize');
    expect(event.action).toBe('synchronize');
  });

  it('falls back to repository.owner.name when owner.login is missing', () => {
    const payload = basePayload();
    payload.repository = { ...payload.repository, owner: { name: 'AndreiDrang' } };
    const event = extractPullRequestEvent(payload, 'delivery-1');
    expect(event.repository.owner).toBe('AndreiDrang');
  });

  it('returns null when the payload is incomplete', () => {
    expect(extractPullRequestEvent({}, 'delivery-1')).toBeNull();
    expect(extractPullRequestEvent(basePayload(), '')).toBeNull();
  });
});
