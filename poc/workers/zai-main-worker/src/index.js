/**
 * zai-main-worker — entrypoint.
 *
 * Receives GitHub webhooks, enforces validation gates, parses the command,
 * authorizes the commenter, then either runs a LIGHT command inline or
 * delegates a HEAVY command to zai-heavy-worker via a Service Binding.
 *
 * GitHub webhooks time out (~10s), so heavy work is ALWAYS offloaded: the
 * main worker acks fast and never blocks on review/impact.
 */

import { GitHubClient } from '../../shared/github.js';
import { verifyWebhookSignature } from '../../shared/crypto.js';
import { parseCommand, isCommand, formatCommandNotAvailable } from '../../shared/commands.js';
import { authorizeCommenter } from '../../shared/auth.js';
import { createLogger, logPerformance, generateCorrelationId } from '../../shared/logging.js';
import { COMMENT_MARKER } from '../../shared/constants.js';
import { classifyCommand } from './router.js';
import { buildDelegationPayload, delegateToHeavy } from './delegator.js';
import { getLightHandler } from './handlers/index.js';

export default {
  async fetch(request, env, ctx) {
    const logger = createLogger(env, 'zai-main-worker');
    const correlationId = generateCorrelationId();
    const startTime = Date.now();

    try {
      // --- Gate 1: method ---
      if (request.method !== 'POST') {
        return new Response('Method Not Allowed', { status: 405 });
      }

      // --- Gate 2: content-type ---
      if (request.headers.get('content-type') !== 'application/json') {
        return new Response('Unsupported Media Type', { status: 415 });
      }

      // --- Gate 3: webhook signature (Web Crypto, no compat flag) ---
      const signatureOk = await verifyWebhookSignature(request, env.GITHUB_WEBHOOK_SECRET);
      if (!signatureOk) {
        logger.warn('Invalid GitHub webhook signature', { correlationId });
        return new Response('Unauthorized', { status: 401 });
      }

      // --- Parse payload ---
      const payload = await request.json();
      const ghEvent = request.headers.get('x-github-event');
      const webhookData = extractWebhookData(payload, ghEvent);
      const internalEvent = getEventType(webhookData);

      logger.info('Received webhook', {
        correlationId,
        event: webhookData.event,
        action: webhookData.action,
        internalEvent,
        repo: webhookData.repository?.full_name,
      });

      // --- Gate 4: only process command-bearing comment events ---
      if (!isCommandEvent(internalEvent) || !isCommand(webhookData.comment?.body)) {
        logger.info('Skipping event', { internalEvent });
        return new Response('OK', { status: 200 });
      }

      const parsed = parseCommand(webhookData.comment.body);
      if (!parsed) {
        return new Response('OK', { status: 200 });
      }

      // --- Gate 5: authorization (collaborator check) ---
      const github = new GitHubClient(env.GITHUB_TOKEN);
      const { owner, name, full_name } = repoCoordinates(webhookData.repository);
      const username = webhookData.comment?.user?.login;

      const authorized = await authorizeCommenter(github, owner, name, username);
      if (!authorized) {
        logger.warn('Unauthorized access attempt', {
          user: username,
          repo: full_name,
          correlationId,
        });
        await postUnauthorizedComment(github, owner, name, webhookData.issue.number, username);
        return new Response('Unauthorized', { status: 403 });
      }

      // --- Route ---
      const bucket = classifyCommand(parsed.type);

      if (bucket === 'heavy') {
        // Offload to heavy worker; ack GitHub immediately.
        delegateToHeavy(env, ctx, buildDelegationPayload(parsed, webhookData));
        logger.info('Delegated heavy command', {
          command: parsed.type,
          repo: full_name,
          correlationId,
        });
        return json(202, {
          status: 'accepted',
          command: parsed.type,
          delegated: true,
        });
      }

      if (bucket === 'light') {
        const handler = getLightHandler(parsed.type);
        if (handler) {
          const result = await handler({
            github,
            env,
            parsed,
            event: {
              repository: webhookData.repository,
              issue: webhookData.issue,
              comment: webhookData.comment,
            },
          });
          logPerformance(env, `light_${parsed.type}`, startTime, {
            repo: full_name,
            correlationId,
          });
          return json(200, result);
        }
        // Known light command without a handler yet → unsupported notice.
        await postUnsupported(github, owner, name, webhookData.issue.number, parsed.type);
        return json(200, { status: 'stub', command: parsed.type });
      }

      // Unsupported: valid /zai syntax but unknown command.
      await postUnsupported(github, owner, name, webhookData.issue.number, parsed.type);
      return json(200, { status: 'unsupported', command: parsed.type });
    } catch (error) {
      logger.error('Error processing request', {
        message: error.message,
        correlationId,
      });
      return new Response('Internal Server Error', { status: 500 });
    }
  },
};

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function extractWebhookData(payload, event) {
  return {
    event, // raw x-github-event header (e.g. 'issue_comment', 'pull_request')
    action: payload.action,
    repository: payload.repository,
    pull_request: payload.pull_request,
    issue: payload.issue,
    comment: payload.comment,
    sender: payload.sender,
    installation: payload.installation,
  };
}

function getEventType(webhookData) {
  // Distinguish comment-bearing events from the payload shape. The raw
  // x-github-event header is logged separately; routing only cares whether
  // this is an issue/PR comment carrying a /zai command.
  const { issue, pull_request } = webhookData;
  if (pull_request) return 'pull_request';
  if (issue && issue.pull_request) return 'pull_request_comment';
  if (issue) return 'issue_comment';
  return 'unknown';
}

function isCommandEvent(internalEvent) {
  return internalEvent === 'pull_request_comment' || internalEvent === 'issue_comment';
}

function repoCoordinates(repository) {
  return {
    owner: repository?.owner?.login,
    name: repository?.name,
    full_name: repository?.full_name,
  };
}

function json(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

async function postUnauthorizedComment(github, owner, name, issueNumber, username) {
  try {
    await github.postComment(
      owner,
      name,
      issueNumber,
      `## ⚠️ Authorization Required\n\n@${username}, you need collaborator access to run /zai commands here.\n\n${COMMENT_MARKER}`,
    );
  } catch {
    /* best-effort */
  }
}

async function postUnsupported(github, owner, name, issueNumber, commandType) {
  try {
    await github.postComment(owner, name, issueNumber, formatCommandNotAvailable(commandType));
  } catch {
    /* best-effort */
  }
}
