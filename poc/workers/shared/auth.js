/**
 * Authorization helpers — shared by both workers.
 *
 * POC policy: require repository collaborator status (stricter than the parent
 * GitHub Actions bot, which authorizes any identifiable user). Centralizing it
 * here lets both workers apply the same policy and makes a future policy change
 * a one-file edit.
 */

import { GitHubClient } from './github.js';
import { resolveSecretValue } from './secrets.js';

/**
 * Authorizes a commenter as a repository collaborator.
 * @param {import('./github.js').GitHubClient} github
 * @param {string} owner
 * @param {string} repo
 * @param {string} username
 * @returns {Promise<boolean>}
 */
export async function authorizeCommenter(github, owner, repo, username) {
  try {
    // 204 = collaborator, 404 = not. Other errors propagate.
    await github.request('GET', `/repos/${owner}/${repo}/collaborators/${username}`);
    return true;
  } catch (error) {
    if (error.status === 404) return false;
    throw error;
  }
}

/**
 * Convenience factory: build a GitHubClient + run the auth check in one call.
 * Useful from the heavy worker, which rebuilds a client per invocation.
 */
export async function isAuthorized(env, owner, repo, username) {
  const github = new GitHubClient(await resolveSecretValue(env.GITHUB_TOKEN));
  return authorizeCommenter(github, owner, repo, username);
}
