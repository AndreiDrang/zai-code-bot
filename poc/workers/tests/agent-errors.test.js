import { describe, expect, it } from 'vitest';

// Unit tests for the agent tool-error classifier: raw internal errors must map
// to stable, user-safe codes/messages before they reach an LLM tool result.

import { AgentProtocolError, toSafeToolError } from '../shared/agent/errors.js';

describe('AgentProtocolError', () => {
  it('carries a stable name and code', () => {
    const error = new AgentProtocolError('unexpected tool payload');
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe('AgentProtocolError');
    expect(error.code).toBe('AGENT_PROTOCOL_ERROR');
    expect(error.message).toBe('unexpected tool payload');
  });
});

describe('toSafeToolError', () => {
  it('maps a JSON parse failure to INVALID_TOOL_ARGUMENTS', () => {
    expect(toSafeToolError(new SyntaxError('Unexpected token in JSON'))).toEqual({
      code: 'INVALID_TOOL_ARGUMENTS',
      message: 'Tool arguments are not valid JSON.',
    });
  });

  it('maps unknown-tool messages to UNKNOWN_TOOL', () => {
    expect(toSafeToolError(new TypeError('Unknown context tool: get_magic'))).toMatchObject({
      code: 'UNKNOWN_TOOL',
    });
    expect(toSafeToolError(new Error('Unknown tool: get_magic'))).toMatchObject({
      code: 'UNKNOWN_TOOL',
    });
  });

  it('maps schema-mismatch messages to INVALID_TOOL_ARGUMENTS', () => {
    const messages = [
      'Arguments for get_diff must be an object',
      'Missing argument for get_diff: path',
      'Unknown argument for get_diff: extra',
      'path for get_diff must be a string',
      'limit for get_commits must be a positive integer',
    ];
    for (const message of messages) {
      expect(toSafeToolError(new TypeError(message))).toEqual({
        code: 'INVALID_TOOL_ARGUMENTS',
        message: 'Tool arguments do not match the required schema.',
      });
    }
  });

  it('passes through an explicit UPPER_SNAKE error code with its message', () => {
    const error = Object.assign(new Error('r2 unavailable'), { code: 'R2_UNAVAILABLE' });
    expect(toSafeToolError(error)).toEqual({
      code: 'R2_UNAVAILABLE',
      message: 'r2 unavailable',
    });
  });

  it('ignores codes that are not UPPER_SNAKE (falls through, keeps message)', () => {
    const error = Object.assign(new Error('weird failure'), { code: 'not-a-code' });
    expect(toSafeToolError(error)).toEqual({
      code: 'TOOL_EXECUTION_FAILED',
      message: 'The requested context could not be loaded.',
    });
  });

  it('falls back to TOOL_EXECUTION_FAILED for arbitrary errors', () => {
    expect(toSafeToolError(new Error('boom'))).toEqual({
      code: 'TOOL_EXECUTION_FAILED',
      message: 'The requested context could not be loaded.',
    });
    expect(toSafeToolError({ message: 'mismatched head sha' })).toEqual({
      code: 'TOOL_EXECUTION_FAILED',
      message: 'The requested context could not be loaded.',
    });
  });

  it('uses a generic message when the carried code has none', () => {
    const error = Object.assign(new Error(''), { code: 'STALE_SNAPSHOT' });
    expect(toSafeToolError(error)).toEqual({
      code: 'STALE_SNAPSHOT',
      message: 'The requested context could not be loaded.',
    });
  });
});
