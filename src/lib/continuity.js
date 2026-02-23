/**
 * Conversation Continuity State Management
 * 
 * Lightweight state persistence for PR thread context without external database.
 * State is stored in the bot's own comment as a JSON object in an HTML comment marker.
 */

const CONTINUITY_MARKER = '<!-- zai-continuity:';
const CONTINUITY_MARKER_END = ' -->';

// Current version for future migrations
const STATE_VERSION = 1;

// Maximum state size in bytes (~2KB)
const MAX_STATE_SIZE = 2048;

/**
 * Encode state data to a compact base64 string
 * @param {Object} data - State data to encode
 * @returns {string} Base64-encoded JSON string
 */
function encodeState(data) {
  const stateWithVersion = {
    v: STATE_VERSION,
    ...data,
  };
  
  const jsonStr = JSON.stringify(stateWithVersion);
  
  // Check size limit
  const sizeBytes = Buffer.byteLength(jsonStr, 'utf8');
  if (sizeBytes > MAX_STATE_SIZE) {
    throw new Error(`State size ${sizeBytes} bytes exceeds limit of ${MAX_STATE_SIZE} bytes`);
  }
  
  // Use base64url encoding (URL-safe, no padding)
  return Buffer.from(jsonStr, 'utf8').toString('base64url');
}

/**
 * Decode state from compact base64 string
 * @param {string} encoded - Base64-encoded state string
 * @returns {Object|null} Decoded state object or null if invalid/corrupted
 */
function decodeState(encoded) {
  if (!encoded || typeof encoded !== 'string') {
    return null;
  }
  
  try {
    // Handle both base64url and standard base64
    let jsonStr;
    try {
      jsonStr = Buffer.from(encoded, 'base64url').toString('utf8');
    } catch {
      jsonStr = Buffer.from(encoded, 'base64').toString('utf8');
    }
    
    const parsed = JSON.parse(jsonStr);
    
    // Validate version - support migration path
    if (!parsed.v) {
      // Legacy state without version - assume v1 format
      return parsed;
    }
    
    if (parsed.v > STATE_VERSION) {
      // Future version - attempt to parse what we can
      console.warn(`State version ${parsed.v} is newer than supported ${STATE_VERSION}, attempting to parse`);
    }
    
    return parsed;
  } catch {
    // Graceful fallback for corrupted state
    return null;
  }
}

/**
 * Extract continuity state from comment body
 * @param {string} body - Comment body text
 * @returns {Object|null} State object or null if not found/corrupted
 */
function extractStateFromComment(body) {
  if (!body || typeof body !== 'string') {
    return null;
  }
  
  const startIdx = body.indexOf(CONTINUITY_MARKER);
  if (startIdx === -1) {
    return null;
  }
  
  const contentStart = startIdx + CONTINUITY_MARKER.length;
  const endIdx = body.indexOf(CONTINUITY_MARKER_END, contentStart);
  
  if (endIdx === -1) {
    return null;
  }
  
  const encoded = body.slice(contentStart, endIdx).trim();
  return decodeState(encoded);
}

/**
 * Create comment body with continuity state embedded
 * @param {string} content - Main comment content
 * @param {Object} state - State data to embed
 * @returns {string} Comment body with embedded state
 */
function createCommentWithState(content, state) {
  let markerContent = '';
  
  if (state && Object.keys(state).length > 0) {
    try {
      const encoded = encodeState(state);
      markerContent = `${CONTINUITY_MARKER} ${encoded}${CONTINUITY_MARKER_END}`;
    } catch {
      console.warn('Failed to encode state');
      // Continue without state marker
    }
  }
  
  if (markerContent) {
    return `${content}\n\n${markerContent}`;
  }
  
  return content;
}

/**
 * Find bot comment containing continuity state
 * @param {Object} octokit - GitHub Octokit instance
 * @param {string} owner - Repository owner
 * @param {string} repo - Repository name
 * @param {number} issueNumber - PR/Issue number
 * @returns {Promise<Object|null>} Comment object or null
 */
async function findStateComment(octokit, owner, repo, issueNumber) {
  const { data: comments } = await octokit.rest.issues.listComments({
    owner,
    repo,
    issue_number: issueNumber,
  });
  
  return comments.find(c => c.body?.includes(CONTINUITY_MARKER)) || null;
}

/**
 * Load continuity state from PR comment
 * @param {Object} octokit - GitHub Octokit instance
 * @param {string} owner - Repository owner
 * @param {string} repo - Repository name
 * @param {number} issueNumber - PR/Issue number
 * @returns {Promise<Object|null>} State object or null if not found/corrupted
 */
async function loadContinuityState(octokit, owner, repo, issueNumber) {
  try {
    const comment = await findStateComment(octokit, owner, repo, issueNumber);
    
    if (!comment) {
      return null;
    }
    
    return extractStateFromComment(comment.body);
  } catch {
    // Graceful fallback - any error returns null
    console.warn('Failed to load continuity state');
    return null;
  }
}

/**
 * Save continuity state to PR comment (creates or updates)
 * @param {Object} octokit - GitHub Octokit instance
 * @param {string} owner - Repository owner
 * @param {string} repo - Repository name
 * @param {number} issueNumber - PR/Issue number
 * @param {Object} state - State data to save
 * @param {Object} options - Additional options
 * @param {string} options.content - Main comment content (if creating new)
 * @param {number} [options.replyToId] - Reply to comment ID
 * @returns {Promise<Object>} Result with action type and comment
 */
async function saveContinuityState(octokit, owner, repo, issueNumber, state, options = {}) {
  const { content = '', replyToId = null } = options;
  
  try {
    const existingComment = await findStateComment(octokit, owner, repo, issueNumber);
    
    if (existingComment) {
      // Extract existing content (remove old state marker)
      let existingContent = existingComment.body;
      const markerStart = existingContent.indexOf(CONTINUITY_MARKER);
      const markerEnd = existingContent.indexOf(CONTINUITY_MARKER_END, markerStart);
      
      if (markerStart !== -1 && markerEnd !== -1) {
        existingContent = existingContent.slice(0, markerStart).trim() + 
          existingContent.slice(markerEnd + CONTINUITY_MARKER_END.length).trim();
      }
      
      // Merge with new content
      const newContent = content || existingContent;
      const newBody = createCommentWithState(newContent, state);
      
      const { data: updated } = await octokit.rest.issues.updateComment({
        owner,
        repo,
        comment_id: existingComment.id,
        body: newBody,
      });
      
      return { action: 'updated', comment: updated };
    } else {
      // Create new comment with state
      if (!content) {
        throw new Error('Cannot create comment without content');
      }
      
      const body = createCommentWithState(content, state);
      
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
  } catch (err) {
    console.warn('Failed to save continuity state');
    throw err;
  }
}

/**
 * Update existing state with new data (merge)
 * @param {Object} currentState - Current state object
 * @param {Object} updates - New data to merge
 * @returns {Object} Merged state
 */
function mergeState(currentState, updates) {
  if (!currentState) {
    return updates;
  }
  
  return {
    ...currentState,
    ...updates,
  };
}

module.exports = {
  CONTINUITY_MARKER,
  CONTINUITY_MARKER_END,
  STATE_VERSION,
  MAX_STATE_SIZE,
  encodeState,
  decodeState,
  extractStateFromComment,
  createCommentWithState,
  findStateComment,
  loadContinuityState,
  saveContinuityState,
  mergeState,
};
