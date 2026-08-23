/**
 * zai-main-worker — entrypoint.
 *
 * Receives GitHub webhooks, enforces validation gates, parses the command,
 * authorizes the commenter, and enqueues the supported LLM command.
 *
 * GitHub webhooks time out (~10s), so LLM work is always offloaded: this worker
 * acknowledges quickly and never blocks on review or describe.
 */

import { GitHubClient } from '../../shared/github.js';
import { verifyWebhookSignature } from '../../shared/crypto.js';
import { resolveSecretValue } from '../../shared/secrets.js';
import {
  parseCommand,
  isCommand,
  formatCommandNotAvailable,
  formatHelp,
} from '../../shared/commands.js';
import { authorizeCommenter } from '../../shared/auth.js';
import { createLogger, generateCorrelationId } from '../../shared/logging.js';
import { COMMENT_MARKER, BOT_FOOTER, HELP_MARKER } from '../../shared/constants.js';
import { classifyCommand } from './router.js';
import {
  extractPullRequestEvent,
  isSupportedPullRequestEvent,
  isPrDescriptionEditEvent,
  planDescriptionRefresh,
  CONTEXT_TRIGGER_ACTIONS,
} from './pr-events.js';
import {
  enqueueJob,
  recoverExpiredJobs,
  replayDueOutbox,
  sweepExpiredStorage,
} from './job-enqueuer.js';
import { createPrContextJob, createCommandJob } from '../../shared/storage/deliveries.js';
import { refreshCommentsSlice } from '../../shared/pr-comments.js';
import { refreshDescriptionSlice } from '../../shared/pr-description.js';
import {
  isPrCommentRefreshEvent,
  planCommentsRefresh,
  COMMAND_TRIGGER_ACTIONS,
} from './comment-events.js';

export default {
  async fetch(request, env, ctx) {
    const logger = createLogger(env, 'zai-main-worker');
    const correlationId = generateCorrelationId();
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

      // --- Mirror PR conversation comments into the comments context slice ---
      // issue_comment created/edited/deleted on a PR trigger a full re-fetch of
      // the conversation (getPrComments) that overwrites comments.json, so the
      // The review handler sees fresh talk between gathers.
      // Best-effort + non-blocking: GitHub is acked immediately and the slice is
      // derivative (the next gather re-captures it from scratch). Runs for ALL
      // PR comments, command or not — a /zai command still flows through below.
      if (isPrCommentRefreshEvent(ghEvent, webhookData, env)) {
        const plan = planCommentsRefresh(webhookData);
        if (plan) {
          ctx.waitUntil(refreshPrComments(env, plan).catch(() => {}));
        }
      }

      // --- Mirror a PR description edit into the description context slice ---
      // pull_request.edited with changes.body carries the NEW body IN the
      // payload itself, so this refresh needs NO API call — it writes
      // pull_request.body straight to description.md (matching the gather's
      // `pullRequest.body || ''`). Best-effort and non-blocking.
      if (isPrDescriptionEditEvent(ghEvent, webhookData.action, payload, env)) {
        const plan = planDescriptionRefresh(payload);
        if (plan) {
          ctx.waitUntil(
            refreshDescriptionSlice({ bucket: env.BOT_ARTIFACTS, ...plan }).catch(() => {}),
          );
        }
      }

      // --- PR context path ---
      // PR events never enter the command parser. Head-producing events gather
      // context for the next review/describe command.
      if (isSupportedPullRequestEvent(webhookData.event, webhookData.action, payload)) {
        const prEvent = extractPullRequestEvent(
          payload,
          request.headers.get('x-github-delivery'),
          webhookData.action,
        );
        if (!prEvent || !env.BOT_DB || !env.BOT_JOBS) {
          logger.error('PR storage is not configured or payload is incomplete', { correlationId });
          return new Response('Service Unavailable', { status: 503 });
        }
        if (!CONTEXT_TRIGGER_ACTIONS.includes(prEvent.action)) {
          return json(200, { status: 'ignored', action: prEvent.action });
        }
        const context = await createPrContextJob(env.BOT_DB, prEvent);
        try {
          await enqueueJob(env, context.job.job_id);
        } catch (error) {
          logger.error('PR job enqueue failed', { message: error?.message, correlationId });
          return new Response('Service Unavailable', { status: 503 });
        }
        return json(202, {
          status: 'accepted',
          kind: 'pr_context',
          jobId: context.job.job_id,
          duplicate: !context.created,
        });
      }

      // --- Gate 4: only process command-bearing comment CREATIONS ---
      // `edited`/`deleted` deliveries carry the full comment body but must not
      // re-execute the command (deleting `/zai review` means "cancel", not
      // "run again"). Missing action degrades to `created` (GitHub always
      // sends one).
      const commentAction = webhookData.action ?? 'created';
      if (
        !isCommandEvent(internalEvent) ||
        !COMMAND_TRIGGER_ACTIONS.includes(commentAction) ||
        !isCommand(webhookData.comment?.body)
      ) {
        logger.info('Skipping event', { internalEvent, action: commentAction });
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

      if (bucket === 'help') {
        await postHelp(github, owner, name, webhookData.issue.number);
        return json(200, { status: 'help', command: parsed.type });
      }

      if (bucket === 'heavy') {
        if (!canRouteDurable(webhookData, env)) {
          return new Response('Service Unavailable', { status: 503 });
        }
        try {
          const created = await createCommandDurableJob(
            env,
            github,
            webhookData,
            parsed.type,
            request.headers.get('x-github-delivery'),
          );
          await enqueueJob(env, created.job.job_id);
          logger.info('Enqueued durable command job', {
            command: parsed.type,
            repo: full_name,
            jobId: created.job.job_id,
            correlationId,
          });
          return json(202, {
            status: 'accepted',
            command: parsed.type,
            jobId: created.job.job_id,
            durable: true,
          });
        } catch (error) {
          logger.error('Durable command job failed', {
            command: parsed.type,
            message: error?.message,
            correlationId,
          });
          return new Response('Service Unavailable', { status: 503 });
        }
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
    issue:
      payload.issue ||
      (event === 'pull_request_review_comment'
        ? { number: payload.pull_request?.number, pull_request: payload.pull_request }
        : payload.issue),
    comment: payload.comment,
    sender: payload.sender,
    installation: payload.installation,
  };
}

function getEventType(webhookData) {
  // Distinguish comment-bearing events from the payload shape. The raw
  // x-github-event header is logged separately; routing only cares whether
  // this is an issue/PR comment carrying a /zai command.
  const { event, issue, pull_request } = webhookData;
  if (event === 'pull_request_review_comment') return 'pull_request_comment';
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

/** A heavy command can take the durable path only on a PR comment with storage. */
function canRouteDurable(webhookData, env) {
  return Boolean(webhookData?.issue?.pull_request && env?.BOT_DB && env?.BOT_JOBS);
}

/**
 * Creates a durable job for a /zai command (issue_comment). Resolves the PR's
 * head via getPullRequest so the job row matches a PR-event job's shape; the
 * queue consumer then runs the handler with the full {github, env, db, job,
 * runId} context.
 */
async function createCommandDurableJob(env, github, webhookData, kind, deliveryId) {
  const { owner, name, full_name } = repoCoordinates(webhookData.repository);
  const prNumber = webhookData.issue.number;
  const pr = await github.getPullRequest(owner, name, prNumber);
  if (!pr?.head?.sha) throw new Error('Could not resolve PR head for command job');
  const event = {
    deliveryId,
    eventName: 'issue_comment',
    action: webhookData.action || 'created',
    repositoryId: webhookData.repository.id,
    repository: { owner, name, fullName: full_name, defaultBranch: null },
    prNumber,
    headSha: pr.head.sha,
    baseSha: pr.base?.sha || null,
    title: pr.title || null,
    authorLogin: pr.user?.login || null,
    state: pr.state || 'open',
  };
  return createCommandJob(env.BOT_DB, event, kind);
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

async function postHelp(github, owner, name, issueNumber) {
  try {
    const comments = await github.getIssueComments(owner, name, issueNumber);
    const existing = Array.isArray(comments)
      ? comments.find(
          (comment) => typeof comment.body === 'string' && comment.body.includes(HELP_MARKER),
        )
      : null;
    if (existing?.id) {
      await github.updateComment(owner, name, existing.id, formatHelp());
    } else {
      await github.postComment(owner, name, issueNumber, formatHelp());
    }
  } catch {
    /* best-effort */
  }
}

/**
 * Full-refresh of the PR `comments` context slice on an issue_comment event.
 * Builds a throwaway GitHubClient (this path runs before the command path
 * constructs one) and runs the shared refreshCommentsSlice. Errors are
 * swallowed by the caller's ctx.waitUntil — the slice is derivative.
 */
async function refreshPrComments(env, plan) {
  const github = new GitHubClient(await resolveSecretValue(env.GITHUB_TOKEN));
  return refreshCommentsSlice({ github, bucket: env.BOT_ARTIFACTS, ...plan });
}
