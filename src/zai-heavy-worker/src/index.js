/**
 * zai-heavy-worker — entrypoint.
 *
 * Receives durable jobs from the BOT_JOBS Queue. It is not publicly exposed;
 * the main worker publishes only opaque job IDs and this worker re-reads the
 * job and all secrets from Cloudflare bindings.
 */

import { processQueueBatch } from './queue.js';

export default {
  async queue(batch, env) {
    await processQueueBatch(batch, env);
  },
};
