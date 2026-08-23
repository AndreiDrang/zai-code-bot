/**
 * Tool adapters intentionally receive Context Service, never an R2 binding.
 * They are provider-agnostic; AgentRunner adapts their schemas for Z.ai.
 */
export async function listFilesTool(args, context) {
  return context.listChangedFiles(args);
}

export async function getDiffTool(args, context) {
  return context.getDiff(args?.path);
}

export async function getFileTool(args, context) {
  return context.getFile(args?.path);
}

export async function getFileRangeTool(args, context) {
  return context.getFileRange(args?.path, {
    startLine: args?.startLine,
    endLine: args?.endLine,
  });
}

export async function getDescriptionTool(args, context) {
  return context.getDescription(args);
}

export async function getCommitsTool(args, context) {
  return context.getCommits(args);
}

export async function getCommentsTool(args, context) {
  return context.getComments(args);
}
