/**
 * zai-heavy-worker — entrypoint.
 *
 * Receives durable jobs from the BOT_JOBS Queue (and retains the legacy
 * Service Binding endpoint for /zai command migration). It is NOT exposed
 * publicly: the queue consumer is the normal caller and the legacy endpoint is
 * authenticated by a shared `ZAI_INTERNAL_TOKEN` header.
 *
 * Queue lifecycle (decoupled from the webhook 10s timeout):
 *   1. verify internal token   → 401 on mismatch
 *   2. parse delegation payload
 *   3. schedule the heavy work via ctx.waitUntil(...)
 *   4. return 202 immediately  → main worker's service-binding fetch resolves fast
 *   5. the heavy work runs to completion (bounded by THIS worker's limits) and
 *      posts its result comment back to GitHub directly
 */

import { GitHubClient } from '../../shared/github.js';
import { createLogger, generateCorrelationId } from '../../shared/logging.js';
import { INTERNAL_TOKEN_HEADER, COMMENT_MARKER, BOT_FOOTER } from '../../shared/constants.js';
import { resolveSecretValue } from '../../shared/secrets.js';
import { getHeavyHandler } from './handlers/index.js';
import { processQueueBatch } from './queue.js';

export default {
  async queue(batch, env) {
    await processQueueBatch(batch, env);
  },

  async fetch(request, env, ctx) {
    const logger = createLogger(env, 'zai-heavy-worker');
    const correlationId = generateCorrelationId();

    // --- Internal auth (defense-in-depth; service binding is already private) ---
    const token = request.headers.get(INTERNAL_TOKEN_HEADER);
    // Resolve the binding: a raw object/Promise would make `token !== env.X`
    // always true and reject every delegated call.
    const expectedToken = await resolveSecretValue(env.ZAI_INTERNAL_TOKEN);
    if (!token || !expectedToken || token !== expectedToken) {
      logger.warn('Rejected internal call: bad token', { correlationId });
      return new Response('Unauthorized', { status: 401 });
    }

    let payload;
    try {
      payload = await request.json();
    } catch {
      return new Response('Bad Request', { status: 400 });
    }

    const commandType = payload?.command?.type;
    const handler = getHeavyHandler(commandType);
    if (!handler) {
      logger.warn('No heavy handler for command', {
        commandType,
        correlationId,
      });
      return json(404, { status: 'no_handler', command: commandType });
    }

    // --- Ack fast; do the long work in this worker's own lifetime. ---
    ctx.waitUntil(
      runHeavy(env, handler, payload, correlationId, logger).catch((err) => {
        logger.error('Heavy work failed', {
          command: commandType,
          message: err?.message,
          correlationId,
        });
      }),
    );

    logger.info('Accepted heavy command', {
      command: commandType,
      repo: payload?.repository?.full_name,
      correlationId,
    });
    return json(202, { status: 'accepted', command: commandType });
  },
};

/**
 * Executes the heavy handler with its own GitHub client. Runs AFTER the 202 has
 * been returned, so failures here surface only in logs (and, best-effort, a
 * PR comment).
 */
async function runHeavy(env, handler, payload, correlationId, logger) {
  const github = new GitHubClient(await resolveSecretValue(env.GITHUB_TOKEN));
  const startedAt = Date.now();

  try {
    await handler({ github, env, payload });
    logger.info('Heavy command completed', {
      command: payload?.command?.type,
      repo: payload?.repository?.full_name,
      durationMs: Date.now() - startedAt,
      correlationId,
    });
  } catch (err) {
    logger.error('Heavy command errored', {
      command: payload?.command?.type,
      message: err?.message,
      durationMs: Date.now() - startedAt,
      correlationId,
    });
    // Best-effort user-visible failure comment.
    try {
      await github.postComment(
        payload.repository?.owner,
        payload.repository?.name,
        payload.issue?.number,
        `## ❌ Command failed\n\nThe \`${payload?.command?.type}\` command could not complete. Please retry.\n\n---\n${BOT_FOOTER}\n\n${COMMENT_MARKER}`,
      );
    } catch {
      /* nothing more we can do */
    }
  }
}

function json(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}
