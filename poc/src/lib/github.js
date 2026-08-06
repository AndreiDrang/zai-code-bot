/**
 * GitHub API Client for Cloudflare Workers
 * Handles all GitHub API interactions
 */

const GITHUB_API_BASE = 'https://api.github.com';

/**
 * GitHub API Client
 */
export class GitHubClient {
  /**
   * @param {string} token - GitHub Personal Access Token
   */
  constructor(token) {
    this.token = token;
    this.baseUrl = GITHUB_API_BASE;
  }
  
  /**
   * Generic request method for GitHub API
   * @param {string} method - HTTP method (GET, POST, PUT, DELETE)
   * @param {string} path - API path
   * @param {Object} [data] - Request body
   * @returns {Promise<Object>} - API response
   */
  async request(method, path, data = null) {
    const url = `${this.baseUrl}${path}`;
    
    const options = {
      method,
      headers: {
        'Authorization': `token ${this.token}`,
        'Accept': 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'zai-code-bot-poc'
      }
    };
    
    if (data) {
      options.body = JSON.stringify(data);
    }
    
    const response = await fetch(url, options);
    
    if (!response.ok) {
      const error = await response.text();
      console.error(`GitHub API error: ${response.status} ${error}`);
      throw new Error(`GitHub API error: ${response.status}`);
    }
    
    return response.json();
  }
  
  /**
   * Verifies GitHub webhook signature
   * @param {Request} request - Cloudflare Request object
   * @param {string} secret - Webhook secret
   * @returns {Promise<boolean>} - Whether signature is valid
   */
  static async verifyWebhookSignature(request, secret) {
    const signature = request.headers.get('x-hub-signature-256');
    const payload = await request.text();
    
    if (!signature || !secret) {
      return false;
    }
    
    const hmac = crypto.createHmac('sha256', secret);
    hmac.update(payload);
    const expectedSignature = `sha256=${hmac.digest('hex')}`;
    
    return crypto.timingSafeEqual(
      Buffer.from(signature),
      Buffer.from(expectedSignature)
    );
  }
  
  /**
   * Gets repository information
   * @param {string} owner - Repository owner
   * @param {string} repo - Repository name
   * @returns {Promise<Object>} - Repository info
   */
  async getRepository(owner, repo) {
    return this.request('GET', `/repos/${owner}/${repo}`);
  }
  
  /**
   * Posts a comment to an issue or PR
   * @param {string} owner - Repository owner
   * @param {string} repo - Repository name
   * @param {number} issueNumber - Issue or PR number
   * @param {string} body - Comment body
   * @returns {Promise<Object>} - Created comment
   */
  async postComment(owner, repo, issueNumber, body) {
    return this.request(
      'POST',
      `/repos/${owner}/${repo}/issues/${issueNumber}/comments`,
      { body }
    );
  }
  
  /**
   * Gets user information
   * @param {string} username - GitHub username
   * @returns {Promise<Object>} - User info
   */
  async getUser(username) {
    return this.request('GET', `/users/${username}`);
  }
  
  /**
   * Checks if user has access to repository
   * @param {string} owner - Repository owner
   * @param {string} repo - Repository name
   * @param {string} username - GitHub username
   * @returns {Promise<boolean>} - Whether user has access
   */
  async checkRepositoryAccess(owner, repo, username) {
    try {
      // Check if user is a collaborator
      await this.request(
        'GET',
        `/repos/${owner}/${repo}/collaborators/${username}`
      );
      return true;
    } catch (error) {
      if (error.message.includes('404')) {
        return false;
      }
      throw error;
    }
  }
  
  /**
   * Gets issue information
   * @param {string} owner - Repository owner
   * @param {string} repo - Repository name
   * @param {number} issueNumber - Issue number
   * @returns {Promise<Object>} - Issue info
   */
  async getIssue(owner, repo, issueNumber) {
    return this.request(
      'GET',
      `/repos/${owner}/${repo}/issues/${issueNumber}`
    );
  }
  
  /**
   * Gets pull request information
   * @param {string} owner - Repository owner
   * @param {string} repo - Repository name
   * @param {number} prNumber - PR number
   * @returns {Promise<Object>} - PR info
   */
  async getPullRequest(owner, repo, prNumber) {
    return this.request(
      'GET',
      `/repos/${owner}/${repo}/pulls/${prNumber}`
    );
  }
}
