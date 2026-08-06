/**
 * Delegates a command to the heavy worker via a Service Binding.
 *
 * Pattern (so GitHub gets its 200 fast):
 *   - main worker fires `env.HEAVY_WORKER.fetch(...)` inside `ctx.waitUntil`
 *   - heavy worker acks with 202 immediately and does the long work in ITS OWN
 *     `ctx.waitUntil`, so main is not held alive for the full review.
 *
 * The service binding is internal to the Cloudflare account (never public),
 * but we still send a shared `ZAI_INTERNAL_TOKEN` header as defense-in-depth.
 */

import { INTERNAL_TOKEN_HEADER, INTERNAL_PATH } from '../../shared/constants.js';
import { createLogger } from '../../shared/logging.js';

/**
 * Builds the JSON body forwarded to the heavy worker.
 * @param {Object} parsed - result of parseCommand()
 * @param {Object} webhookData - parsed webhook fields
 * @returns {Object}
 */
export function buildDelegationPayload(parsed, webhookData) {
  const { repository, issue, comment, pull_request, sender } = webhookData;
  return {
    command: parsed,
    repository: {
      owner: repository?.owner?.login,
      name: repository?.name,
      full_name: repository?.full_name,
    },
    issue: { number: issue?.number },
    prNumber: pull_request?.number ?? null,
    comment: {
      id: comment?.id,
      body: comment?.body,
      user: comment?.user?.login,
    },
    sender: sender?.login ?? null,
  };
}

/**
 * Fires the delegation request without blocking the response.
 *
 * Robustness: the service-binding call is wrapped so a synchronous throw
 * (e.g. an unbound HEAVY_WORKER) becomes a rejected promise handed to
 * ctx.waitUntil and logged, rather than crashing the already-acked webhook.
 *
 * @param {Object} env - Worker env (must expose HEAVY_WORKER binding + secrets)
 * @param {Object} ctx - ExecutionContext (provides waitUntil)
 * @param {Object} payload - from buildDelegationPayload()
 */
export function delegateToHeavy(env, ctx, payload) {
  // Service bindings accept an arbitrary hostname; only the path is read.
  const url = `https://zai-heavy-worker.internal${INTERNAL_PATH}`;
  const init = {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      [INTERNAL_TOKEN_HEADER]: env.ZAI_INTERNAL_TOKEN || '',
    },
    body: JSON.stringify(payload),
  };

  const send = async () => {
    try {
      return await env.HEAVY_WORKER.fetch(url, init);
    } catch (err) {
      createLogger(env, 'zai-main-worker:delegate').error('heavy-worker fetch failed', {
        message: err?.message || String(err),
      });
      return null;
    }
  };

  // ctx.waitUntil ensures the fetch is actually sent before main returns.
  ctx.waitUntil(send());
}
