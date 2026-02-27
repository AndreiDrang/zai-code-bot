const { describe, test, beforeEach } = require('node:test');
const assert = require('node:assert');
const { handleDescribeCommand, DESCRIBE_MARKER, AI_DESCRIPTION_START } = require('../src/lib/handlers/describe');

describe('describe handler', () => {
  describe('handleDescribeCommand', () => {
    
    test('happy path - updates PR body with AI description', async () => {
      // Track API calls
      const calls = {
        listCommits: [],
        pullsGet: [],
        pullsUpdate: [],
        createComment: [],
        updateComment: [],
        createReaction: []
      };
      
      // Create mock octokit
      const mockOctokit = {
        rest: {
          pulls: {
            listCommits: async ({ owner, repo, pull_number, per_page }) => {
              calls.listCommits.push({ owner, repo, pull_number, per_page });
              return {
                data: [
                  { commit: { message: 'feat: add new feature' } },
                  { commit: { message: 'fix: resolve bug' } }
                ]
              };
            },
            get: async ({ owner, repo, pull_number }) => {
              calls.pullsGet.push({ owner, repo, pull_number });
              return {
                data: {
                  body: 'Original PR description'
                }
              };
            },
            update: async ({ owner, repo, pull_number, body }) => {
              calls.pullsUpdate.push({ owner, repo, pull_number, body });
              return { data: { body } };
            }
          },
          issues: {
            listComments: async () => ({ data: [] }),
            createComment: async ({ owner, repo, issue_number, body, in_reply_to_comment_id }) => {
              calls.createComment.push({ owner, repo, issue_number, body, in_reply_to_comment_id });
              return { data: { id: 1 } };
            },
            updateComment: async () => {
              calls.updateComment.push({});
              return { data: { id: 1 } };
            }
          },
          reactions: {
            createForIssueComment: async () => {
              calls.createReaction.push({});
              return { data: { content: 'rocket' } };
            }
          }
        }
      };
      
      // Mock apiClient
      const mockApiClient = {
        call: async ({ apiKey, model, prompt }) => {
          return { success: true, data: 'This PR adds a new feature and resolves a bug.' };
        }
      };
      
      // Create context
      const context = {
        octokit: mockOctokit,
        owner: 'test-owner',
        repo: 'test-repo',
        issueNumber: 1,
        commentId: 100,
        apiClient: mockApiClient,
        apiKey: 'test-key',
        model: 'test-model',
        logger: {
          info: () => {},
          error: () => {}
        }
      };
      
      const result = await handleDescribeCommand(context, {});
      
      // Assert success
      assert.strictEqual(result.success, true);
      
      // Assert commits were fetched
      assert.strictEqual(calls.listCommits.length, 1);
      assert.strictEqual(calls.listCommits[0].pull_number, 1);
      
      // Assert PR body was fetched
      assert.strictEqual(calls.pullsGet.length, 1);
      
      // Assert PR was updated
      assert.strictEqual(calls.pullsUpdate.length, 1);
      const updatedBody = calls.pullsUpdate[0].body;
      assert.ok(updatedBody.includes('Original PR description'));
      assert.ok(updatedBody.includes(AI_DESCRIPTION_START));
      assert.ok(updatedBody.includes('This PR adds a new feature and resolves a bug.'));
      assert.ok(updatedBody.includes('<!-- ZAI_DESCRIPTION_END -->'));
      
      // Assert success comment was posted
      assert.strictEqual(calls.createComment.length, 1);
      assert.ok(calls.createComment[0].body.includes('✅ I have successfully updated the PR description'));
      
      // Assert reaction was set
      assert.strictEqual(calls.createReaction.length, 1);
    });
    
    test('replaces existing AI section on re-run', async () => {
      const calls = {
        pullsUpdate: [],
        createComment: []
      };
      
      const existingBody = `Original PR description

---

<!-- ZAI_DESCRIBE_COMMAND -->

<!-- ZAI_DESCRIPTION_START -->
🤖 **Z.ai Auto-generated Description:**

Old description here
<!-- ZAI_DESCRIPTION_END -->
`;
      
      const mockOctokit = {
        rest: {
          pulls: {
            listCommits: async () => ({
              data: [{ commit: { message: 'chore: update stuff' } }]
            }),
            get: async () => ({ data: { body: existingBody } }),
            update: async ({ body }) => {
              calls.pullsUpdate.push({ body });
              return { data: { body } };
            }
          },
          issues: {
            listComments: async () => ({ data: [] }),
            createComment: async ({ body }) => {
              calls.createComment.push({ body });
              return { data: { id: 1 } };
            },
            updateComment: async () => ({ data: { id: 1 } })
          },
          reactions: {
            createForIssueComment: async () => ({ data: { content: 'rocket' } })
          }
        }
      };
      
      const mockApiClient = {
        call: async () => ({ success: true, data: 'New updated description.' })
      };
      
      const context = {
        octokit: mockOctokit,
        owner: 'test-owner',
        repo: 'test-repo',
        issueNumber: 1,
        commentId: 100,
        apiClient: mockApiClient,
        apiKey: 'test-key',
        model: 'test-model',
        logger: { info: () => {}, error: () => {} }
      };
      
      const result = await handleDescribeCommand(context, {});
      
      assert.strictEqual(result.success, true);
      assert.strictEqual(calls.pullsUpdate.length, 1);
      
      const newBody = calls.pullsUpdate[0].body;
      
      // Should have only ONE AI_DESCRIPTION_START
      const startCount = (newBody.match(/<!-- ZAI_DESCRIPTION_START -->/g) || []).length;
      assert.strictEqual(startCount, 1);
      
      // Should NOT contain old description
      assert.ok(!newBody.includes('Old description here'));
      
      // Should contain new description
      assert.ok(newBody.includes('New updated description.'));
    });
    
    test('handles empty PR body', async () => {
      const calls = { pullsUpdate: [] };
      
      const mockOctokit = {
        rest: {
          pulls: {
            listCommits: async () => ({
              data: [{ commit: { message: 'feat: add feature' } }]
            }),
            get: async () => ({ data: { body: '' } }),
            update: async ({ body }) => {
              calls.pullsUpdate.push({ body });
              return { data: { body } };
            }
          },
          issues: {
            listComments: async () => ({ data: [] }),
            createComment: async () => ({ data: { id: 1 } }),
            updateComment: async () => ({ data: { id: 1 } })
          },
          reactions: {
            createForIssueComment: async () => ({ data: { content: 'rocket' } })
          }
        }
      };
      
      const mockApiClient = {
        call: async () => ({ success: true, data: 'A feature was added.' })
      };
      
      const context = {
        octokit: mockOctokit,
        owner: 'test-owner',
        repo: 'test-repo',
        issueNumber: 1,
        commentId: 100,
        apiClient: mockApiClient,
        apiKey: 'test-key',
        model: 'test-model',
        logger: { info: () => {}, error: () => {} }
      };
      
      const result = await handleDescribeCommand(context, {});
      
      assert.strictEqual(result.success, true);
      assert.strictEqual(calls.pullsUpdate.length, 1);
      
      const newBody = calls.pullsUpdate[0].body;
      
      // With empty original body, the new body should contain AI section
      assert.ok(newBody.includes(AI_DESCRIPTION_START), 'Should contain AI description start marker');
      assert.ok(newBody.includes('A feature was added.'), 'Should contain generated description');
    });
    
    test('LLM failure - body unchanged, error posted', async () => {
      const calls = {
        pullsUpdate: [],
        createComment: [],
        createReaction: []
      };
      
      const originalBody = 'Original PR description';
      
      const mockOctokit = {
        rest: {
          pulls: {
            listCommits: async () => ({
              data: [{ commit: { message: 'feat: add feature' } }]
            }),
            get: async () => ({ data: { body: originalBody } }),
            update: async () => {
              calls.pullsUpdate.push({});
              return { data: {} };
            }
          },
          issues: {
            listComments: async () => ({ data: [] }),
            createComment: async ({ body }) => {
              calls.createComment.push({ body });
              return { data: { id: 1 } };
            },
            updateComment: async () => ({ data: { id: 1 } })
          },
          reactions: {
            createForIssueComment: async ({ content }) => {
              calls.createReaction.push({ content });
              return { data: { content } };
            }
          }
        }
      };
      
      // Mock LLM to fail
      const mockApiClient = {
        call: async () => ({ success: false, error: 'API error: rate limited' })
      };
      
      const context = {
        octokit: mockOctokit,
        owner: 'test-owner',
        repo: 'test-repo',
        issueNumber: 1,
        commentId: 100,
        apiClient: mockApiClient,
        apiKey: 'test-key',
        model: 'test-model',
        logger: { info: () => {}, error: () => {} }
      };
      
      const result = await handleDescribeCommand(context, {});
      
      // Assert failure result
      assert.strictEqual(result.success, false);
      assert.ok(result.error.includes('API error'));
      
      // PR body should NOT be updated
      assert.strictEqual(calls.pullsUpdate.length, 0);
      
      // Error comment should be posted
      assert.strictEqual(calls.createComment.length, 1);
      assert.ok(calls.createComment[0].body.includes('❌ Failed to generate description'));
      
      // Error reaction should be set
      assert.strictEqual(calls.createReaction.length, 1);
      assert.strictEqual(calls.createReaction[0].content, '-1');
    });
    
    test('handles PR with no commits', async () => {
      const calls = { createComment: [] };
      
      const mockOctokit = {
        rest: {
          pulls: {
            listCommits: async () => ({ data: [] }),
            get: async () => ({ data: { body: 'Some body' } }),
            update: async () => ({ data: {} })
          },
          issues: {
            listComments: async () => ({ data: [] }),
            createComment: async ({ body }) => {
              calls.createComment.push({ body });
              return { data: { id: 1 } };
            },
            updateComment: async () => ({ data: { id: 1 } })
          },
          reactions: {
            createForIssueComment: async () => ({ data: { content: 'rocket' } })
          }
        }
      };
      
      const mockApiClient = {
        call: async () => ({ success: true, data: 'Description' })
      };
      
      const context = {
        octokit: mockOctokit,
        owner: 'test-owner',
        repo: 'test-repo',
        issueNumber: 1,
        commentId: 100,
        apiClient: mockApiClient,
        apiKey: 'test-key',
        model: 'test-model',
        logger: { info: () => {}, error: () => {} }
      };
      
      const result = await handleDescribeCommand(context, {});
      
      // Should return success
      assert.strictEqual(result.success, true);
      
      // Should post "no commits" message
      assert.strictEqual(calls.createComment.length, 1);
      assert.ok(calls.createComment[0].body.includes('No commits found in this PR'));
      
      // Should NOT call LLM or update PR
    });
    
  });
});
