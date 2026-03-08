const { upsertComment, setReaction, REACTIONS } = require('../comments');
const { truncateContext, DEFAULT_MAX_CHARS } = require('../context');

const DESCRIBE_MARKER = '<!-- ZAI_DESCRIBE_COMMAND -->';
const AI_DESCRIPTION_START = '\n\n---\n<!-- ZAI_DESCRIPTION_START -->\n🤖 **Z.ai Auto-generated Description:**\n\n';
const AI_DESCRIPTION_END = '\n<!-- ZAI_DESCRIPTION_END -->';

async function handleDescribeCommand(context, args) {
  const { octokit, owner, repo, issueNumber, commentId, apiClient, apiKey, model, logger } = context;

  try {
    // 1. Fetch commits (max 30 to prevent API timeouts)
    const commitsResponse = await octokit.rest.pulls.listCommits({
      owner,
      repo,
      pull_number: issueNumber,
      per_page: 30
    });
    
    // 2. Extract and truncate commit messages
    const allMessages = commitsResponse.data
      .map(c => c.commit.message)
      .join('\n\n');
    
    const commitMessages = truncateContext(allMessages, 8000).content;
    
    if (!commitMessages) {
      await upsertComment(octokit, owner, repo, issueNumber,
        `## Z.ai Describe\n\nNo commits found in this PR.\n\n${DESCRIBE_MARKER}`,
        DESCRIBE_MARKER, { replyToId: commentId });
      return { success: true };
    }
    
    // 3. Build LLM prompt (as string, not array)
    const prompt = `You are an expert Staff Engineer and Technical Writer. Your task is to analyze the provided Git commit messages and synthesize a clear, comprehensive, and well-structured Pull Request description.

### Instructions:
1. **Analyze and Consolidate:** Do not simply repeat the commit messages. Group related changes, ignore trivial or redundant commits (e.g., "fix typo", "wip", "merge"), and deduce the overall intent of the Pull Request.
2. **Tone and Style:** Use a professional, objective tone. Write in the imperative mood for bullet points (e.g., "Add user authentication" instead of "Added user authentication").
3. **Strict Formatting:** Output ONLY the requested Markdown structure. Do not include any conversational filler, greetings, or introductory phrases. If a specific category has no relevant commits, **omit that section entirely**.

### Required PR Description Structure:

**## 🚀 Overview**
[Provide a concise 1-2 sentence summary of the primary purpose and value of this Pull Request based on the commits.]

**## ✨ Features & Enhancements**
* [Bullet points detailing new functionality or improvements]

**## 🐛 Bug Fixes**
* [Bullet points explaining the issues resolved]

**## 🔨 Refactoring & Chore**
* [Bullet points covering code restructuring, technical debt removal, or style changes]

**## ⚙️ Infrastructure & Tooling**
* [Bullet points regarding CI/CD updates, dependency bumps, or configuration changes]

---
### Input Data:
<commit_messages>
${commitMessages}
</commit_messages>`;

    
    // 4. Call LLM
    const llmResult = await apiClient.call({ apiKey, model, prompt });
    
    if (!llmResult.success) {
      logger.error({ error: llmResult.error }, 'LLM call failed for describe command');
      await upsertComment(octokit, owner, repo, issueNumber,
        `## Z.ai Describe\n\n❌ Failed to generate description. Please try again later.\n\n${DESCRIBE_MARKER}`,
        DESCRIBE_MARKER, { replyToId: commentId });
      await setReaction(octokit, owner, repo, commentId, REACTIONS.X);
      return { success: false, error: llmResult.error };
    }
    
    const generatedDescription = llmResult.data;
    
    // 5. Fetch current PR body
    const prResponse = await octokit.rest.pulls.get({ owner, repo, pull_number: issueNumber });
    let currentBody = prResponse.data.body || '';
    
    // 6. Remove existing AI section (between markers or from AI_DESCRIPTION_START to end)
    const startMarker = '<!-- ZAI_DESCRIPTION_START -->';
    const endMarker = '<!-- ZAI_DESCRIPTION_END -->';
    const startIndex = currentBody.indexOf(startMarker);
    
    if (startIndex !== -1) {
      // Remove from start marker to end marker (or to end if no end marker)
      const endIndex = currentBody.indexOf(endMarker, startIndex);
      if (endIndex !== -1) {
        currentBody = currentBody.substring(0, startIndex) + currentBody.substring(endIndex + endMarker.length);
      } else {
        currentBody = currentBody.substring(0, startIndex);
      }
    }
    
    // 7. Build new body
    const newBody = currentBody.trimEnd() + AI_DESCRIPTION_START + generatedDescription + AI_DESCRIPTION_END;
    
    // 8. Update PR
    await octokit.rest.pulls.update({
      owner,
      repo,
      pull_number: issueNumber,
      body: newBody
    });
    
    // 9. Post success reply
    await upsertComment(octokit, owner, repo, issueNumber,
      `✅ I have successfully updated the PR description based on your commits!\n\n${DESCRIBE_MARKER}`,
      DESCRIBE_MARKER, { replyToId: commentId });
    
    await setReaction(octokit, owner, repo, commentId, REACTIONS.ROCKET);
    
    return { success: true };
    
  } catch (error) {
    logger.error({ error: error.message }, 'Describe command failed');
    await upsertComment(octokit, owner, repo, issueNumber,
      `## Z.ai Describe\n\n❌ An error occurred: ${error.message}\n\n${DESCRIBE_MARKER}`,
      DESCRIBE_MARKER, { replyToId: commentId });
    await setReaction(octokit, owner, repo, commentId, REACTIONS.X);
    return { success: false, error: error.message };
  }
}

module.exports = { handleDescribeCommand, DESCRIBE_MARKER, AI_DESCRIPTION_START };
