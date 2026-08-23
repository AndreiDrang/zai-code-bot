export class AgentProtocolError extends Error {
  constructor(message) {
    super(message);
    this.name = 'AgentProtocolError';
    this.code = 'AGENT_PROTOCOL_ERROR';
  }
}

export function toSafeToolError(error) {
  if (error instanceof SyntaxError) {
    return {
      code: 'INVALID_TOOL_ARGUMENTS',
      message: 'Tool arguments are not valid JSON.',
    };
  }

  const message = String(error?.message || '');
  if (/Unknown context tool|Unknown tool/.test(message)) {
    return {
      code: 'UNKNOWN_TOOL',
      message: 'The requested tool is not available for this pull request.',
    };
  }
  if (
    /Arguments for|Missing argument|Unknown argument|must be a string|must be a positive integer/.test(
      message,
    )
  ) {
    return {
      code: 'INVALID_TOOL_ARGUMENTS',
      message: 'Tool arguments do not match the required schema.',
    };
  }
  if (error?.code && /^[A-Z][A-Z0-9_]+$/.test(error.code)) {
    return {
      code: error.code,
      message: String(error.message || 'The requested context could not be loaded.'),
    };
  }
  return {
    code: 'TOOL_EXECUTION_FAILED',
    message: 'The requested context could not be loaded.',
  };
}
