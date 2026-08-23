export const CONTEXT_TOOL_SCHEMAS = Object.freeze([
  {
    name: 'list_changed_files',
    description:
      'List files changed by this pull request with file status and line-change counts. Use this to navigate the pull request or narrow the files to inspect. Do not use it to retrieve source code or diff content.',
    input_schema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        pathPrefix: {
          type: 'string',
          description: 'Optional repository-relative path prefix used to filter changed files.',
        },
      },
    },
  },
  {
    name: 'get_diff',
    description:
      'Get the unified diff for one file changed by this pull request. During review, inspect the highest-risk changed files first and use this before requesting source. Do not use it for unchanged files, generated files, lockfiles, or documentation unless they are relevant to a concrete concern. Do not repeat an identical request; use get_file instead when current implementation is needed.',
    input_schema: {
      type: 'object',
      additionalProperties: false,
      required: ['path'],
      properties: {
        path: {
          type: 'string',
          description: 'Repository-relative path of a file changed by this pull request.',
        },
      },
    },
  },
  {
    name: 'get_file',
    description:
      'Get the current contents of a repository file at the pull request HEAD. For a changed file, use this only after its diff raises a specific implementation question. Use it for a related unchanged file only when a changed diff directly depends on it. Prefer get_file_range for a specific part of a large file.',
    input_schema: {
      type: 'object',
      additionalProperties: false,
      required: ['path'],
      properties: {
        path: {
          type: 'string',
          description: 'Repository-relative path at the pull request HEAD.',
        },
      },
    },
  },
  {
    name: 'get_file_range',
    description:
      'Get an inclusive line range from a repository file at the pull request HEAD. Use this for targeted source inspection when the relevant area is known.',
    input_schema: {
      type: 'object',
      additionalProperties: false,
      required: ['path', 'startLine', 'endLine'],
      properties: {
        path: {
          type: 'string',
          description: 'Repository-relative path at the pull request HEAD.',
        },
        startLine: {
          type: 'integer',
          minimum: 1,
          description: 'First line to include, using 1-based inclusive line numbers.',
        },
        endLine: {
          type: 'integer',
          minimum: 1,
          description: 'Last line to include, using 1-based inclusive line numbers.',
        },
      },
    },
  },
  {
    name: 'get_description',
    description:
      'Get the pull request title and description. Use this only when it is not already available in the current conversation.',
    input_schema: {
      type: 'object',
      additionalProperties: false,
      properties: {},
    },
  },
  {
    name: 'get_commits',
    description:
      'Get commits included in this pull request. Use this when commit history or commit intent is needed. Do not use it to retrieve file-level changes; use get_diff instead.',
    input_schema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        limit: {
          type: 'integer',
          minimum: 1,
          description: 'Maximum number of commits to return.',
        },
      },
    },
  },
  {
    name: 'get_comments',
    description:
      'Get pull request discussion and review comments. Use this when existing feedback or unresolved discussion is material to the analysis. Optionally filter inline comments by file path.',
    input_schema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        path: {
          type: 'string',
          description: 'Optional repository-relative path for filtering inline review comments.',
        },
        limit: {
          type: 'integer',
          minimum: 1,
          description: 'Maximum number of comments to return.',
        },
      },
    },
  },
]);
