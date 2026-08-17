export const DEFAULT_AGENT_LIMITS = Object.freeze({
  maxIterations: 10,
  maxToolCalls: 30,
  maxToolCallsPerIteration: 10,
  maxRunDurationMs: 120000,
  maxLlmRequestDurationMs: 30000,
});

export function resolveAgentLimits(overrides = {}) {
  return {
    ...DEFAULT_AGENT_LIMITS,
    ...Object.fromEntries(
      Object.entries(overrides).filter(([, value]) => Number.isFinite(value) && value > 0),
    ),
  };
}
