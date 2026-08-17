import { describe, expect, it } from 'vitest';
import {
  getAvailableCommands,
  isCommand,
  parseCommand,
  formatCommandNotAvailable,
  formatHelp,
} from '../shared/commands.js';

describe('shared/commands', () => {
  it('accepts help, review, and describe in the command allowlist', () => {
    expect(getAvailableCommands()).toEqual(['help', 'review', 'describe']);
    expect(parseCommand('/zai help')).toMatchObject({ type: 'help', isValid: true });
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

  it('returns null for missing, non-string, and non-command input', () => {
    expect(parseCommand(null)).toBeNull();
    expect(parseCommand(undefined)).toBeNull();
    expect(parseCommand('')).toBeNull();
    expect(parseCommand(12345)).toBeNull();
    expect(parseCommand({ body: '/zai review' })).toBeNull();
    expect(parseCommand('please review this')).toBeNull();
    expect(isCommand('plain text')).toBe(false);
  });

  it('renders a safe response for removed commands', () => {
    const message = formatCommandNotAvailable('impact');
    expect(message).toContain('/zai impact');
    expect(message).toContain('/zai help');
  });

  it('renders the supported command list', () => {
    expect(formatHelp()).toContain('/zai help');
    expect(formatHelp()).toContain('/zai review');
    expect(formatHelp()).toContain('/zai describe');
  });
});
