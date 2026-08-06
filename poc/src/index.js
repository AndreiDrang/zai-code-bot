/**
 * Z.ai Code Bot - Proof-of-Concept
 * Main Cloudflare Worker for handling GitHub webhooks
 * 
 * This POC implements only the /zai help command to validate
 * the Cloudflare Computer architecture.
 */

import { GitHubClient } from './lib/github.js';
import { parseCommand, isCommand } from './lib/commands.js';
import { handleHelpCommand, handleUnsupportedCommand } from './lib/handlers/help.js';
import { createLogger, logPerformance } from './lib/logging.js';
import { COMMENT_MARKER, ERROR_MESSAGES } from './config/constants.js';

// Secret names (configured via wrangler secret put)
const GITHUB_TOKEN = 'GITHUB_TOKEN';
const GITHUB_WEBHOOK_SECRET = 'GITHUB_WEBHOOK_SECRET';

/**
 * Creates application logger
 * @param {Object} env - Environment variables
 * @returns {Object} - Logger instance
 */
function createAppLogger(env) {
  return createLogger(env, 'zai-code-bot-poc');
}

/**
 * Parses GitHub webhook payload
 * @param {Request} request - Cloudflare Request object
 * @returns {Promise<Object>} - Parsed webhook data
 */
async function parseGitHubWebhook(request) {
  const payload = await request.json();
  const headers = request.headers;
  
  return {
    event: headers.get('x-github-event'),
    action: payload.action,
    repository: payload.repository,
    pull_request: payload.pull_request,
    issue: payload.issue,
    comment: payload.comment,
    sender: payload.sender,
    installation: payload.installation
  };
}

/**
 * Determines event type from webhook data
 * @param {Object} webhookData - Parsed webhook data
 * @returns {string} - Event type
 */
function getEventType(webhookData) {
  const { event, pull_request, issue } = webhookData;
  
  if (event === 'pull_request') {
    return `pull_request_${webhookData.action}`;
  }
  
  if (event === 'issue_comment') {
    if (issue && issue.pull_request) {
      return 'pull_request_comment';
    }
    return 'issue_comment';
  }
  
  if (event === 'pull_request_review_comment') {
    return 'pull_request_review_comment';
  }
  
  return event;
}

/**
 * Checks if event should be processed
 * @param {Object} webhookData - Parsed webhook data
 * @returns {boolean} - Whether to process event
 */
function shouldProcessEvent(webhookData) {
  const { event, comment } = webhookData;
  
  // Process comment events with commands
  if (event === 'issue_comment' || event === 'pull_request_comment') {
    return isCommand(comment?.body);
  }
  
  // Process PR review comments
  if (event === 'pull_request_review_comment') {
    return isCommand(comment?.body);
  }
  
  return false;
}

/**
 * Processes comment with command
 * @param {Object} env - Environment variables
 * @param {Object} webhookData - Parsed webhook data
 * @returns {Promise<Response>} - Cloudflare Response
 */
async function processCommentCommand(env, webhookData) {
  const logger = createAppLogger(env);
  const startTime = Date.now();
  
  const { repository, issue, comment } = webhookData;
  
  logger.info('Processing comment command', {
    repo: repository?.full_name,
    issue: issue?.number,
    user: comment?.user?.login
  });
  
  try {
    // Parse command
    const command = parseCommand(comment.body);
    
    if (!command) {
      logger.warn('No command detected', { text: comment.body });
      return new Response('Not a command', { status: 200 });
    }
    
    // Create GitHub client
    const github = new GitHubClient(env[GITHUB_TOKEN]);
    
    // Check authorization
    const hasAccess = await github.checkRepositoryAccess(
      repository.owner.login,
      repository.name,
      comment.user.login
    );
    
    if (!hasAccess) {
      logger.warn('Unauthorized access attempt', {
        user: comment.user.login,
        repo: repository.full_name
      });
      
      await github.postComment(
        repository.owner.login,
        repository.name,
        issue.number,
        `## ⚠️ Authorization Required

@${comment.user.login}, you don't have permission to run /zai commands on this repository.

Please ensure you have write access to this repository.

${COMMENT_MARKER}`
      );
      
      return new Response('Unauthorized', { status: 403 });
    }
    
    // Route command
    if (command.type === 'help') {
      const result = await handleHelpCommand({
        github,
        event: { repository, issue, comment }
      });
      
      logPerformance(env, 'help_command', startTime, {
        repo: repository.full_name,
        issue: issue.number
      });
      
      return new Response(JSON.stringify(result), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      });
    } else {
      // For POC, only help is supported
      const result = await handleUnsupportedCommand({
        github,
        event: { repository, issue, comment }
      });
      
      logPerformance(env, 'unsupported_command', startTime, {
        command: command.type,
        repo: repository.full_name
      });
      
      return new Response(JSON.stringify(result), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      });
    }
    
  } catch (error) {
    logger.error('Error processing command:', error);
    
    // Try to post error comment if we have GitHub client
    try {
      const github = new GitHubClient(env[GITHUB_TOKEN]);
      await github.postComment(
        repository.owner.login,
        repository.name,
        issue.number,
        `## ❌ Internal Error

An error occurred while processing your command:

\`\`\`
${error.message}
\`\`\`

${COMMENT_MARKER}`
      );
    } catch (postError) {
      console.error('Failed to post error comment:', postError);
    }
    
    return new Response(JSON.stringify({
      status: 'error',
      error: error.message
    }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
}

/**
 * Main Cloudflare Worker export
 */
export default {
  async fetch(request, env, ctx) {
    const logger = createAppLogger(env);
    const startTime = Date.now();
    
    try {
      // Only accept POST requests
      if (request.method !== 'POST') {
        return new Response('Method Not Allowed', { status: 405 });
      }
      
      // Check Content-Type
      const contentType = request.headers.get('content-type');
      if (contentType !== 'application/json') {
        return new Response('Unsupported Media Type', { status: 415 });
      }
      
      // Verify GitHub webhook signature
      const isValid = await GitHubClient.verifyWebhookSignature(
        request,
        env[GITHUB_WEBHOOK_SECRET]
      );
      
      if (!isValid) {
        logger.warn('Invalid GitHub webhook signature');
        return new Response('Unauthorized', { status: 401 });
      }
      
      // Parse webhook
      const webhookData = await parseGitHubWebhook(request);
      
      logger.info('Received webhook', {
        event: webhookData.event,
        action: webhookData.action,
        repo: webhookData.repository?.full_name
      });
      
      // Check if we should process this event
      if (!shouldProcessEvent(webhookData)) {
        logger.info('Skipping event', { event: webhookData.event });
        return new Response('OK', { status: 200 });
      }
      
      // Process comment command
      const result = await processCommentCommand(env, webhookData);
      
      logPerformance(env, 'webhook_processing', startTime, {
        event: webhookData.event,
        status: result.status
      });
      
      return result;
      
    } catch (error) {
      logger.error('Error processing request:', error);
      return new Response('Internal Server Error', { status: 500 });
    }
  }
};
