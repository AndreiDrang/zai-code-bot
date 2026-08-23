export const DEFAULT_AGENT_LIMITS = Object.freeze({
  maxToolCalls: 30,
  maxToolCallsPerIteration: 10,
  maxRetrievedBytes: 512 * 1024,
  maxRunDurationMs: 5 * 60 * 1000,
  maxLlmRequestDurationMs: 30000,
  finalizationReserveMs: 40000,
});

export function resolveAgentLimits(overrides = {}) {
  return {
    ...DEFAULT_AGENT_LIMITS,
    ...Object.fromEntries(
      Object.entries(overrides).filter(
        ([key, value]) =>
          Object.hasOwn(DEFAULT_AGENT_LIMITS, key) && Number.isFinite(value) && value > 0,
      ),
    ),
  };
}
