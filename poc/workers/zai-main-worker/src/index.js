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
import { resolveSecretValue } from '../../shared/secrets.js';
import { parseCommand, isCommand, formatCommandNotAvailable } from '../../shared/commands.js';
import { authorizeCommenter } from '../../shared/auth.js';
import { createLogger, logPerformance, generateCorrelationId } from '../../shared/logging.js';
import { COMMENT_MARKER, BOT_FOOTER } from '../../shared/constants.js';
import { classifyCommand } from './router.js';
import { buildDelegationPayload, delegateToHeavy } from './delegator.js';
import { getLightHandler } from './handlers/index.js';
import { extractPullRequestEvent, isSupportedPullRequestEvent } from './pr-events.js';
import {
  enqueueJob,
  recoverExpiredJobs,
  replayDueOutbox,
  sweepExpiredStorage,
} from './job-enqueuer.js';
import { createPrPreviewJob } from '../../shared/storage/deliveries.js';

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
      // Secrets Store bindings can surface as string | {get()} | Promise;
      // resolve to a plain string before HMAC (else it stringifies to
      // "[object Object]" and every signature check fails).
      const webhookSecret = await resolveSecretValue(env.GITHUB_WEBHOOK_SECRET);
      const signatureOk = await verifyWebhookSignature(request, webhookSecret);
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

      // --- Durable PR event path ---
      // PR events never enter the command parser. They are recorded in D1 and
      // published as a small job ID so the heavy worker can retry safely.
      if (isSupportedPullRequestEvent(webhookData.event, webhookData.action)) {
        const prEvent = extractPullRequestEvent(
          payload,
          request.headers.get('x-github-delivery'),
          webhookData.action,
        );
        if (!prEvent || !env.BOT_DB || !env.BOT_JOBS) {
          logger.error('PR storage is not configured or payload is incomplete', { correlationId });
          return new Response('Service Unavailable', { status: 503 });
        }
        const { job, created } = await createPrPreviewJob(env.BOT_DB, prEvent);
        try {
          await enqueueJob(env, job.job_id);
        } catch (error) {
          logger.error('PR job enqueue failed', { message: error?.message, correlationId });
          return new Response('Service Unavailable', { status: 503 });
        }
        return json(202, {
          status: 'accepted',
          kind: 'pr_preview',
          jobId: job.job_id,
          duplicate: !created,
        });
      }

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
      const github = new GitHubClient(await resolveSecretValue(env.GITHUB_TOKEN));
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

  async scheduled(_controller, env) {
    const leases = await recoverExpiredJobs(env, 100);
    const outbox = await replayDueOutbox(env, 25);
    const artifacts = await sweepExpiredStorage(env, 100);
    return { leases, outbox, artifacts };
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
      `## ⚠️ Authorization Required\n\n@${username}, you need collaborator access to run /zai commands here.\n\n---\n${BOT_FOOTER}\n\n${COMMENT_MARKER}`,
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
