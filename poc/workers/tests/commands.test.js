import { describe, expect, it } from 'vitest';
import {
  parseCommand,
  isCommand,
  getAvailableCommands,
  formatHelp,
  formatCommandNotAvailable,
} from '../shared/commands.js';
import { COMMENT_MARKER } from '../shared/constants.js';

describe('shared/commands', () => {
  describe('parseCommand', () => {
    it.each([
      ['/zai help', 'help', true],
      ['/zai review', 'review', true],
      ['/zai impact', 'impact', true],
      ['/zai describe', 'describe', true],
      ['/zai ask', 'ask', true],
      ['/zai explain', 'explain', true],
      ['/zai HELP', 'help', true], // command type is case-insensitive
    ])('parses %p -> %s (valid=%p)', (input, type, isValid) => {
      const result = parseCommand(input);
      expect(result).not.toBeNull();
      expect(result.type).toBe(type);
      expect(result.isValid).toBe(isValid);
      expect(result.raw).toBe(input.trim());
    });

    it('captures a single argument', () => {
      expect(parseCommand('/zai explain 10-20').args).toBe('10-20');
    });

    it('captures multi-word free-form arguments', () => {
      expect(parseCommand('/zai ask why is this slow?').args).toBe('why is this slow?');
    });

    it('marks an unrecognized command type as invalid but still returns it', () => {
      const result = parseCommand('/zai bogus');
      expect(result.type).toBe('bogus');
      expect(result.isValid).toBe(false);
    });

    it('trims surrounding whitespace', () => {
      expect(parseCommand('   /zai help   ').type).toBe('help');
    });

    it.each([
      ['/zai-bot help', 'removed /zai-bot slash form'],
      ['@zai-bot help', 'removed @zai-bot mention form'],
      ['random text', 'plain text'],
      ['', 'empty string'],
      [null, 'null'],
      [42, 'non-string'],
    ])('returns null for %s', (input) => {
      expect(parseCommand(input)).toBeNull();
    });
  });

  describe('isCommand', () => {
    it('returns true for a valid /zai command', () => {
      expect(isCommand('/zai help')).toBe(true);
    });

    it.each([
      ['@zai-bot review (mention removed)', '@zai-bot review'],
      ['/zai-bot review (slash form removed)', '/zai-bot review'],
      ['random text', 'random text'],
      ['empty', ''],
      ['null', null],
    ])('returns false for %s', (_label, input) => {
      expect(isCommand(input)).toBe(false);
    });
  });

  describe('getAvailableCommands', () => {
    it('returns the full allowlist in order', () => {
      expect(getAvailableCommands()).toEqual([
        'help',
        'ask',
        'explain',
        'describe',
        'review',
        'impact',
      ]);
    });

    it('returns a defensive copy (mutations do not leak)', () => {
      getAvailableCommands().push('sneaky');
      expect(getAvailableCommands()).not.toContain('sneaky');
    });
  });

  describe('formatHelp', () => {
    it('includes the help and review examples', () => {
      const help = formatHelp();
      expect(help).toContain('/zai help');
      expect(help).toContain('/zai review');
    });

    it('embeds the hidden comment marker', () => {
      expect(formatHelp()).toContain(COMMENT_MARKER);
    });

    it('credits AndreiDrang with a GitHub link in the footer', () => {
      expect(formatHelp()).toContain('[AndreiDrang](https://github.com/AndreiDrang)');
    });

    it('credits Z.ai and Cloudflare Workers in the footer', () => {
      const help = formatHelp();
      expect(help).toContain('[Z.ai](https://z.ai)');
      expect(help).toContain('[Cloudflare Workers](https://cloudflare.com)');
    });
  });

  describe('formatCommandNotAvailable', () => {
    it('renders the unimplemented command and the marker', () => {
      const msg = formatCommandNotAvailable('impact');
      expect(msg).toContain('/zai impact');
      expect(msg).toContain(COMMENT_MARKER);
    });
  });
});
