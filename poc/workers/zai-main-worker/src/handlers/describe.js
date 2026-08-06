/**
 * Handler for /zai describe — a LIGHT command (commits → LLM → PR description).
 *
 * STUB: posts a "not yet implemented" notice. When migrated, this handler will
 * fetch commits via the shared GitHubClient, call the Z.ai API, and post the
 * generated description. Because it involves an LLM call, consider whether it
 * should stay inline or move to the heavy worker based on measured latency.
 */

import { formatCommandNotAvailable } from '../../../shared/commands.js';

/**
 * @param {Object} ctx
 * @param {import('../../shared/github.js').GitHubClient} ctx.github
 * @param {Object} ctx.event - { repository, issue, comment }
 * @returns {Promise<Object>}
 */
export async function handleDescribeCommand({ github, event }) {
  const { repository, issue } = event;
  await github.postComment(
    repository.owner.login,
    repository.name,
    issue.number,
    formatCommandNotAvailable('describe'),
  );
  return {
    status: 'stub',
    action: 'describe',
    repository: repository.full_name,
    issue: issue.number,
  };
}

export function canHandle(commandType) {
  return commandType === 'describe';
}
