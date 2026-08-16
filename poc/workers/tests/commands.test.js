import { describe, expect, it } from 'vitest';
import { getAvailableCommands, isCommand, parseCommand, formatCommandNotAvailable } from '../shared/commands.js';

describe('shared/commands', () => {
  it('accepts only review and describe in the command allowlist', () => {
    expect(getAvailableCommands()).toEqual(['review', 'describe']);
    expect(parseCommand('/zai review')).toMatchObject({ type: 'review', isValid: true });
    expect(parseCommand('/zai describe')).toMatchObject({ type: 'describe', isValid: true });
    expect(parseCommand('/zai ask')).toMatchObject({ type: 'ask', isValid: false });
  });

  it('keeps command parsing case-insensitive and preserves arguments', () => {
    expect(parseCommand('/zai REVIEW')).toMatchObject({ type: 'review', args: '' });
    expect(parseCommand('/zai describe extra')).toMatchObject({
      type: 'describe',
      args: 'extra',
    });
  });

  it('does not recognize removed invocation forms', () => {
    expect(isCommand('@zai-bot review')).toBe(false);
    expect(isCommand('/zai-bot review')).toBe(false);
  });

  it('renders a safe response for removed commands', () => {
    expect(formatCommandNotAvailable('impact')).toContain('/zai impact');
  });
});
