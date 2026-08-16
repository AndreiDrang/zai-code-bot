export const CONTEXT_TOOL_SCHEMAS = Object.freeze([
  {
    name: 'list_changed_files',
    description: 'List changed files in the gathered pull request snapshot.',
    input_schema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        pathPrefix: {
          type: 'string',
          description: 'Optional repository-relative path prefix.',
        },
      },
    },
  },
  {
    name: 'get_diff',
    description: 'Return the collected patch for one changed file in the pull request.',
    input_schema: {
      type: 'object',
      additionalProperties: false,
      required: ['path'],
      properties: {
        path: {
          type: 'string',
          description: 'Exact repository-relative path returned by list_files.',
        },
      },
    },
  },
  {
    name: 'get_file',
    description: 'Get a repository file at the immutable pull request head revision.',
    input_schema: {
      type: 'object',
      additionalProperties: false,
      required: ['path'],
      properties: {
        path: {
          type: 'string',
          description: 'Repository-relative file path.',
        },
      },
    },
  },
  {
    name: 'get_file_range',
    description: 'Get a bounded inclusive line range from a repository file.',
    input_schema: {
      type: 'object',
      additionalProperties: false,
      required: ['path', 'startLine', 'endLine'],
      properties: {
        path: { type: 'string' },
        startLine: { type: 'integer', minimum: 1 },
        endLine: { type: 'integer', minimum: 1 },
      },
    },
  },
  {
    name: 'get_description',
    description: 'Get the pull request title and description.',
    input_schema: {
      type: 'object',
      additionalProperties: false,
      properties: {},
    },
  },
  {
    name: 'get_commits',
    description: 'List commits included in the pull request.',
    input_schema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        limit: { type: 'integer', minimum: 1 },
      },
    },
  },
  {
    name: 'get_comments',
    description: 'Get pull request discussion comments, optionally filtered by file.',
    input_schema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        path: { type: 'string' },
        limit: { type: 'integer', minimum: 1 },
      },
    },
  },
]);
