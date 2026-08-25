/**
 * Authorization helpers — shared by both workers.
 *
 * Authorization policy: require repository collaborator status (stricter than
 * the earlier GitHub Actions bot, which authorized any identifiable user).
 * Centralizing it here lets both workers apply the same policy and makes a
 * future policy change a one-file edit.
 *
 * Auth context: all clients authenticate as the GitHub App installation
 * (PAT support removed), so the collaborator check requires the App to hold
 * the \"Collaborators: read-only\" repository permission.
 */

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
    if (error.status === 403) {
      // An installation token without the \"Collaborators: read-only\"
      // permission gets 403 from GitHub. Surface it as a loud config error —
      // misclassifying it as \"not a collaborator\" would silently lock out
      // every legitimate /zai command.
      const error403 = new Error(
        'app_permission_missing: collaborator check requires Collaborators read-only',
      );
      error403.code = 'app_permission_missing';
      error403.retryable = false;
      throw error403;
    }
    throw error;
  }
}
