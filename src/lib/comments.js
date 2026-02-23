const REACTIONS = {
  EYES: 'eyes',
  THINKING: 'thinking',
  ROCKET: 'rocket',
  X: 'x',
};

async function findCommentByMarker(octokit, owner, repo, issueNumber, marker) {
  const { data: comments } = await octokit.rest.issues.listComments({
    owner,
    repo,
    issue_number: issueNumber,
  });
  
  return comments.find(c => c.body.includes(marker)) || null;
}

async function upsertComment(octokit, owner, repo, issueNumber, body, marker, options = {}) {
  const { replyToId = null, updateExisting = true } = options;
  
  let existingComment = null;
  if (!replyToId && updateExisting) {
    existingComment = await findCommentByMarker(octokit, owner, repo, issueNumber, marker);
  }
  
  if (existingComment) {
    const { data: updated } = await octokit.rest.issues.updateComment({
      owner,
      repo,
      comment_id: existingComment.id,
      body,
    });
    return { action: 'updated', comment: updated };
  } else {
    const createParams = {
      owner,
      repo,
      issue_number: issueNumber,
      body,
    };
    
    if (replyToId) {
      createParams.in_reply_to_comment_id = replyToId;
    }
    
    const { data: created } = await octokit.rest.issues.createComment(createParams);
    return { action: 'created', comment: created };
  }
}

async function addReaction(octokit, owner, repo, commentId, reaction) {
  try {
    const { data: result } = await octokit.rest.reactions.createForIssueComment({
      owner,
      repo,
      comment_id: commentId,
      content: reaction,
    });
    return { success: true, reaction: result };
  } catch (error) {
    if (error.status === 404) {
      return { success: false, error: 'comment_not_found', details: error };
    }
    throw error;
  }
}

async function updateReaction(octokit, owner, repo, commentId, _oldReaction, newReaction) {
  const result = await addReaction(octokit, owner, repo, commentId, newReaction);
  
  return {
    oldReactionRemoved: true,
    newReaction: result,
  };
}

async function setReaction(octokit, owner, repo, commentId, reactionContent) {
  return addReaction(octokit, owner, repo, commentId, reactionContent);
}

module.exports = {
  REACTIONS,
  findCommentByMarker,
  upsertComment,
  addReaction,
  updateReaction,
  setReaction,
};
