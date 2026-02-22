/**
 * Mock factories for testing the GitHub Action
 */

/**
 * Creates a mock Octokit instance with stubbed REST API methods
 * @param {Object} options - Configuration options
 * @param {Array} options.files - Files to return from listFiles
 * @param {Array} options.comments - Comments to return from listComments
 * @returns {Object} Mock Octokit instance
 */
function createMockOctokit(options = {}) {
  const { files = [], comments = [] } = options;

  return {
    rest: {
      pulls: {
        listFiles: async () => ({
          data: files,
        }),
      },
      issues: {
        listComments: async () => ({
          data: comments,
        }),
        createComment: async () => ({
          data: { id: 1, body: 'created' },
        }),
        updateComment: async () => ({
          data: { id: 1, body: 'updated' },
        }),
      },
    },
  };
}

/**
 * Creates a mock Z.ai API client
 * @param {Object} options - Configuration options
 * @param {string|Error} options.response - Response to return or Error to throw
 * @returns {Function} Mock API client function
 */
function createMockApiClient(options = {}) {
  const { response = 'Mock review response' } = options;

  return async (apiKey, model, prompt) => {
    if (response instanceof Error) {
      throw response;
    }
    return response;
  };
}

/**
 * Creates a mock context object for testing
 * @param {Object} payload - The event payload
 * @returns {Object} Mock GitHub context
 */
function createMockContext(payload) {
  return {
    payload,
    repo: {
      owner: payload.repository?.owner?.login || 'test-owner',
      repo: payload.repository?.name || 'test-repo',
    },
  };
}

/**
 * Creates mock @actions/core functions
 * @returns {Object} Mock core functions
 */
function createMockCore() {
  const inputs = {};
  const outputs = {};
  const messages = [];

  return {
    getInput: (name, options) => {
      const value = inputs[name];
      if (options?.required && !value) {
        throw new Error(`Input required and not provided: ${name}`);
      }
      return value || '';
    },
    setInput: (name, value) => {
      inputs[name] = value;
    },
    getOutput: (name) => outputs[name],
    setOutput: (name, value) => {
      outputs[name] = value;
    },
    info: (message) => messages.push({ level: 'info', message }),
    warning: (message) => messages.push({ level: 'warning', message }),
    error: (message) => messages.push({ level: 'error', message }),
    setFailed: (message) => messages.push({ level: 'failed', message }),
    startGroup: () => {},
    endGroup: () => {},
    messages,
    inputs,
    outputs,
  };
}

module.exports = {
  createMockOctokit,
  createMockApiClient,
  createMockContext,
  createMockCore,
};
