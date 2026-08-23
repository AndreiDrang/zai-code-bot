export class ContextError extends Error {
  constructor(code, message, details = undefined) {
    super(message);
    this.name = 'ContextError';
    this.code = code;
    this.details = details;
  }
}

export function contextError(code, message, details) {
  return new ContextError(code, message, details);
}
