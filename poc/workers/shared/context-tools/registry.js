import {
  getDiffTool,
  getFileRangeTool,
  getFileTool,
  getCommentsTool,
  getCommitsTool,
  getDescriptionTool,
  listFilesTool,
} from './handlers.js';
import { CONTEXT_TOOL_SCHEMAS } from './schemas.js';

const HANDLERS = Object.freeze({
  list_changed_files: listFilesTool,
  get_diff: getDiffTool,
  get_file: getFileTool,
  get_file_range: getFileRangeTool,
  get_description: getDescriptionTool,
  get_commits: getCommitsTool,
  get_comments: getCommentsTool,
});

export function getContextToolDefinitions() {
  return CONTEXT_TOOL_SCHEMAS;
}

function validateArguments(name, args) {
  const schema = CONTEXT_TOOL_SCHEMAS.find((entry) => entry.name === name);
  if (!schema) throw new TypeError(`Unknown context tool: ${name}`);
  if (args == null || typeof args !== 'object' || Array.isArray(args)) {
    throw new TypeError(`Arguments for ${name} must be an object`);
  }
  const properties = schema.input_schema.properties || {};
  for (const key of Object.keys(args)) {
    if (!Object.hasOwn(properties, key)) {
      throw new TypeError(`Unknown argument for ${name}: ${key}`);
    }
  }
  for (const key of schema.input_schema.required || []) {
    if (!(key in args)) throw new TypeError(`Missing argument for ${name}: ${key}`);
  }
  for (const [key, definition] of Object.entries(properties)) {
    if (!(key in args)) continue;
    const value = args[key];
    if (definition.type === 'string' && typeof value !== 'string') {
      throw new TypeError(`${key} for ${name} must be a string`);
    }
    if (definition.type === 'integer' && (!Number.isInteger(value) || value < definition.minimum)) {
      throw new TypeError(`${key} for ${name} must be a positive integer`);
    }
  }
}

export async function executeContextTool(name, args, context) {
  const handler = HANDLERS[name];
  if (!handler) throw new TypeError(`Unknown context tool: ${name}`);
  validateArguments(name, args);
  return handler(args, context);
}
