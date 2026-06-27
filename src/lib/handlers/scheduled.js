/**
 * Scheduled Tasks Handler
 * 
 * Handles scheduled (cron-based) execution of tasks like AGENTS.md updates.
 * Supports flexible configuration via YAML and extensible command handlers.
 */

const https = require('node:https');
const { parseCommand, isValid } = require('../commands');
const { loadScheduledConfig, getTasksToRun, getGistUrl } = require('../config/scheduled-config');
const { createLogger, generateCorrelationId } = require('../logging');
const core = require('@actions/core');

// Handler registry for scheduled commands
const SCHEDULED_HANDLERS = {
  'update-agents': handleUpdateAgentsTask,
};

/**
 * Main entry point for scheduled events
 * @param {Object} context - GitHub actions context
 * @param {string} apiKey - Z.ai API key
 * @param {string} model - Z.ai model
 * @param {string} owner - Repository owner
 * @param {string} repo - Repository name
 * @returns {Promise<Object>} - Execution result
 */
async function handleScheduledEvent(context, apiKey, model, owner, repo) {
  const github = require('@actions/github');
  const octokit = github.getOctokit(process.env.GITHUB_TOKEN || core.getInput('GITHUB_TOKEN'));
  const logger = createLogger(generateCorrelationId(), {
    eventName: 'schedule',
    owner,
    repo,
  });
  
  logger.info('Scheduled event received');
  
  try {
    // Load configuration
    const config = await loadScheduledConfig(octokit, owner, repo);
    
    if (!config) {
      logger.info('No scheduled configuration found (.zai-scheduled.yml), skipping scheduled tasks');
      return { 
        success: true, 
        skipped: true, 
        reason: 'no configuration',
        message: 'No .zai-scheduled.yml configuration found. Scheduled tasks are disabled.'
      };
    }
    
    logger.info(`Loaded scheduled configuration with ${config.tasks.length} task(s)`);
    
    // Get tasks to run for this schedule
    const eventSchedule = context.payload?.schedule;
    const tasks = getTasksToRun(config, eventSchedule);
    
    if (tasks.length === 0) {
      logger.info('No tasks to run for this schedule');
      return { 
        success: true, 
        skipped: true, 
        reason: 'no tasks',
        message: 'No enabled tasks match this schedule.'
      };
    }
    
    logger.info(`Found ${tasks.length} task(s) to execute: ${tasks.map(t => t.id).join(', ')}`);
    
    // Execute each task sequentially
    const results = [];
    for (let i = 0; i < tasks.length; i++) {
      const task = tasks[i];
      logger.info(`[${i + 1}/${tasks.length}] Executing task: ${task.id}`);
      
      const result = await executeScheduledTask({
        octokit,
        apiKey,
        model,
        owner,
        repo,
        task,
        config,
        logger,
        context,
      });
      
      results.push(result);
      
      // Add delay between tasks to avoid rate limiting (except for last task)
      if (i < tasks.length - 1) {
        const delayMs = 5000;
        logger.info(`Waiting ${delayMs}ms before next task...`);
        await new Promise(resolve => setTimeout(resolve, delayMs));
      }
    }
    
    // Log summary
    const successCount = results.filter(r => r.success).length;
    const failureCount = results.filter(r => !r.success).length;
    const prCount = results.filter(r => r.prCreated).length;
    
    logger.info(`Scheduled tasks completed: ${successCount} succeeded, ${failureCount} failed, ${prCount} PR(s) created`);
    
    return {
      success: failureCount === 0,
      results,
      executed: tasks.length,
      succeeded: successCount,
      failed: failureCount,
      prsCreated: prCount,
      message: `Executed ${tasks.length} task(s): ${successCount} succeeded, ${failureCount} failed`,
    };
    
  } catch (error) {
    logger.error({ error: error.message, stack: error.stack }, 'Scheduled event handler failed');
    return { 
      success: false, 
      error: error.message,
      message: `Scheduled event failed: ${error.message}`
    };
  }
}

/**
 * Execute a single scheduled task
 * @param {Object} params - Execution parameters
 * @param {Object} params.octokit - GitHub Octokit instance
 * @param {string} params.apiKey - Z.ai API key
 * @param {string} params.model - Z.ai model
 * @param {string} params.owner - Repository owner
 * @param {string} params.repo - Repository name
 * @param {Object} params.task - Task configuration
 * @param {Object} params.config - Full configuration
 * @param {Object} params.logger - Logger instance
 * @param {Object} params.context - GitHub actions context
 * @returns {Promise<Object>} - Task execution result
 */
async function executeScheduledTask(params) {
  const { octokit, apiKey, model, owner, repo, task, config, logger, context } = params;
  
  try {
    // Get handler for this command
    const handler = getScheduledHandler(task.command);
    
    if (!handler) {
      logger.warn(`No handler found for command: ${task.command}`);
      return {
        success: false,
        taskId: task.id,
        command: task.command,
        error: `Unknown scheduled command: ${task.command}`,
        message: `No handler registered for command '${task.command}'`,
      };
    }
    
    // Build execution context with utility functions
    const executionContext = buildExecutionContext({
      octokit,
      apiKey,
      model,
      owner,
      repo,
      task,
      config,
      logger,
      context,
    });
    
    // Execute handler
    logger.info(`Executing handler for command: ${task.command}`);
    const result = await handler(executionContext);
    
    return {
      success: result.success,
      taskId: task.id,
      command: task.command,
      changes: result.changes,
      prCreated: result.prCreated,
      prNumber: result.prNumber,
      prUrl: result.prUrl,
      message: result.message || `Task ${task.id} completed successfully`,
    };
    
  } catch (error) {
    logger.error({ error: error.message, stack: error.stack, taskId: task.id }, 'Task execution failed');
    return {
      success: false,
      taskId: task.id,
      command: task.command,
      error: error.message,
      message: `Task ${task.id} failed: ${error.message}`,
    };
  }
}

/**
 * Build execution context with utility functions for handlers
 * @param {Object} params - Context parameters
 * @returns {Object} - Execution context
 */
function buildExecutionContext(params) {
  const { octokit, apiKey, model, owner, repo, task, config, logger, context } = params;
  
  const targetBranch = task.config?.branch || config.defaults?.branch || 'main';
  
  return {
    octokit,
    apiKey,
    model,
    owner,
    repo,
    task,
    config,
    logger,
    context,
    targetBranch,
    // Utility functions
    fetchFromUrl: fetchFromUrl,
    fetchFile: async (path, ref) => fetchFileContent(octokit, owner, repo, path, ref || targetBranch),
    updateFile: async (path, content, ref, commitMessage) => 
      updateFileInRepo(octokit, owner, repo, path, content, ref || targetBranch, commitMessage),
    createPullRequest: async (prParams) => createPR(octokit, owner, repo, prParams),
    getFileSha: async (path, ref) => getFileSha(octokit, owner, repo, path, ref || targetBranch),
  };
}

/**
 * Get handler function for a scheduled command
 * @param {string} command - Command name
 * @returns {Function|null} - Handler function or null
 */
function getScheduledHandler(command) {
  return SCHEDULED_HANDLERS[command] || null;
}

/**
 * Register a new scheduled command handler
 * @param {string} command - Command name
 * @param {Function} handler - Handler function
 */
function registerScheduledHandler(command, handler) {
  SCHEDULED_HANDLERS[command] = handler;
}

/**
 * Get all registered scheduled command handlers
 * @returns {Object} - Map of command names to handlers
 */
function getAllScheduledHandlers() {
  return { ...SCHEDULED_HANDLERS };
}

// ============================================================================
// TASK HANDLERS
// ============================================================================

/**
 * Handle AGENTS.md update task
 * Fetches command from Gist, executes it, and creates PR with updates
 * @param {Object} context - Execution context
 * @returns {Promise<Object>} - Result with changes information
 */
async function handleUpdateAgentsTask(context) {
  const { 
    octokit, 
    apiKey,
    model,
    owner, 
    repo, 
    task, 
    config, 
    logger,
    targetBranch,
    fetchFromUrl,
    fetchFile,
    createPullRequest 
  } = context;
  
  const gistUrl = getGistUrl(task.config, config.defaults);
  const manualFiles = task.config?.files || ['AGENTS.md'];
  const autoDiscover = task.config?.auto_discover_files || false;
  const prTitle = task.config?.pr_title || 'chore: update AGENTS.md files';
  const prBody = task.config?.pr_body || 'Automated weekly update of AGENTS.md files from gist';
  const commitMessage = task.config?.commit_message || 'docs: update AGENTS.md from scheduled task';
  
  if (!gistUrl) {
    logger.error('No gist_url configured for update-agents task. Set ZAI_AGENTS_GIST_URL environment variable or configure in .zai-scheduled.yml');
    return { 
      success: false, 
      error: 'Missing gist_url configuration',
      message: 'update-agents task requires gist_url. Set ZAI_AGENTS_GIST_URL environment variable or configure in .zai-scheduled.yml'
    };
  }
  
  logger.info(`Fetching content from gist: ${gistUrl}`);
  logger.info(`Auto-discovery mode: ${autoDiscover ? 'ENABLED' : 'DISABLED'}`);
  
  try {
    // Step 1: Fetch content from gist
    let gistContent;
    try {
      gistContent = await fetchFromUrl(gistUrl);
    } catch (error) {
      logger.error({ error: error.message, url: gistUrl }, 'Failed to fetch from gist URL');
      return { 
        success: false, 
        error: `Failed to fetch from gist: ${error.message}`,
        message: `Could not fetch content from ${gistUrl}`
      };
    }
    
    if (!gistContent || gistContent.trim() === '') {
      logger.error('Gist returned empty content');
      return { 
        success: false, 
        error: 'Empty response from gist URL',
        message: 'Gist URL returned no content'
      };
    }
    
    logger.info(`Fetched ${gistContent.length} characters from gist`);
    
    // Step 2: Execute the command from Gist
    // In auto-discovery mode, the command should return structured data with multiple files
    // In manual mode, the command returns single content for all specified files
    let fileUpdates;
    
    if (autoDiscover) {
      // Auto-discovery mode: command returns structured response with file paths and contents
      logger.info('Executing command in auto-discovery mode - expecting structured file map');
      fileUpdates = await executeCommandAndGetFileUpdates({
        commandText: gistContent,
        octokit,
        apiKey,
        model,
        owner,
        repo,
        targetBranch,
        logger,
      });
      
      if (!fileUpdates || fileUpdates.length === 0) {
        logger.warn('Command returned no file updates in auto-discovery mode, falling back to manual mode');
        // Fallback to manual mode with default file
        fileUpdates = await processManualFiles(manualFiles, gistContent, fetchFile, targetBranch, logger);
      } else {
        logger.info(`Auto-discovery found ${fileUpdates.length} file(s) to update`);
      }
    } else {
      // Manual mode: use hardcoded file list with single content
      logger.info(`Processing ${manualFiles.length} manually specified file(s)`);
      let generatedContent;
      
      try {
        generatedContent = await executeCommandAndGetContent({
          commandText: gistContent,
          octokit,
          apiKey,
          model,
          owner,
          repo,
          targetBranch,
          logger,
        });
        
        if (!generatedContent || generatedContent === gistContent) {
          generatedContent = gistContent;
        }
      } catch (error) {
        logger.warn({ error: error.message }, 'Failed to execute command, using raw gist content');
        generatedContent = gistContent;
      }
      
      fileUpdates = await processManualFiles(manualFiles, generatedContent, fetchFile, targetBranch, logger);
    }
    
    // Step 3: Check if there are any actual changes
    const updatedFiles = fileUpdates.filter(f => f.changed).map(f => f.file);
    
    if (updatedFiles.length === 0) {
      logger.info('No files need updating');
      return {
        success: true,
        changes: fileUpdates,
        prCreated: false,
        message: 'No updates needed - all files are current',
      };
    }
    
    logger.info(`Creating PR with updates for ${updatedFiles.length} file(s): ${updatedFiles.join(', ')}`);
    
    // Create PR with all changes
    const filesToUpdate = fileUpdates
      .filter(f => f.changed)
      .map(f => ({
        path: f.file,
        content: f.newContent,
      }));
    
    const prResult = await createPullRequest({
      title: prTitle,
      body: buildPrBody(prBody, updatedFiles, task.id),
      base: targetBranch,
      files: filesToUpdate,
      commitMessage,
    });
    
    return {
      success: true,
      changes: fileUpdates,
      prCreated: true,
      prNumber: prResult?.number,
      prUrl: prResult?.html_url,
      message: `Created PR #${prResult?.number} with ${updatedFiles.length} file(s) updated`,
    };
    
  } catch (error) {
    logger.error({ error: error.message, stack: error.stack }, 'AGENTS.md update task failed');
    return {
      success: false,
      error: error.message,
      message: `Update task failed: ${error.message}`,
    };
  }
}

/**
 * Process manually specified files with generated content
 * @param {Array<string>} filePaths - List of file paths to update
 * @param {string} content - Content to write to each file
 * @param {Function} fetchFile - Function to fetch current file content
 * @param {string} targetBranch - Target branch
 * @param {Object} logger - Logger instance
 * @returns {Promise<Array<Object>>} - Array of file update objects
 */
async function processManualFiles(filePaths, content, fetchFile, targetBranch, logger) {
  const changes = [];
  
  for (const filePath of filePaths) {
    try {
      const currentContent = await fetchFile(filePath, targetBranch);
      
      if (currentContent === null) {
        logger.info(`File ${filePath} does not exist, will be created`);
        changes.push({
          file: filePath,
          oldContent: null,
          newContent: content,
          changed: true,
          isNew: true,
        });
      } else if (currentContent !== content) {
        logger.info(`File ${filePath} needs update`);
        changes.push({
          file: filePath,
          oldContent: currentContent,
          newContent: content,
          changed: true,
        });
      } else {
        logger.info(`File ${filePath} is up to date`);
        changes.push({
          file: filePath,
          changed: false,
        });
      }
    } catch (error) {
      logger.error({ error: error.message, file: filePath }, 'Failed to check file');
      changes.push({
        file: filePath,
        error: error.message,
        changed: false,
      });
    }
  }
  
  return changes;
}

/**
 * Execute a command and get structured file updates (for auto-discovery mode)
 * The command should return a JSON structure with file paths and their contents
 * @param {Object} params - Execution parameters
 * @param {string} params.commandText - The command text to execute
 * @param {Object} params.octokit - GitHub Octokit instance
 * @param {string} params.apiKey - Z.ai API key
 * @param {string} params.model - Z.ai model
 * @param {string} params.owner - Repository owner
 * @param {string} params.repo - Repository name
 * @param {string} params.targetBranch - Target branch
 * @param {Object} params.logger - Logger instance
 * @returns {Promise<Array<Object>>} - Array of {file, oldContent, newContent, changed, isNew} objects
 */
async function executeCommandAndGetFileUpdates(params) {
  const { commandText, octokit, apiKey, model, owner, repo, targetBranch, logger } = params;
  
  if (!commandText || commandText.trim() === '') {
    logger.warn('Command text is empty, cannot execute');
    return [];
  }
  
  try {
    // Check if it's a valid /zai command
    const parseResult = parseCommand(commandText);
    
    // Build prompt for auto-discovery mode
    // The command should scan the repo and return a JSON structure with all AGENTS.md files
    const prompt = buildAutoDiscoveryPrompt(commandText, owner, repo, targetBranch);
    
    // Call Z.ai API to execute the command
    const response = await callZaiApiWithRetry(apiKey, model, prompt, logger);
    
    if (!response || !response.content) {
      logger.warn('Z.ai API returned empty content');
      return [];
    }
    
    // Parse the response to extract file updates
    // Expected format: JSON array of {file: string, content: string} objects
    // Or a special format that we can parse
    const fileUpdates = parseFileUpdatesFromResponse(response.content, octokit, owner, repo, targetBranch, fetchFileContent, logger);
    
    return fileUpdates;
    
  } catch (error) {
    logger.error({ error: error.message }, 'Failed to execute command for file discovery');
    throw error;
  }
}

/**
 * Build prompt for auto-discovery mode
 * @param {string} commandText - The command text
 * @param {string} owner - Repository owner
 * @param {string} repo - Repository name
 * @param {string} branch - Target branch
 * @returns {string} - Formatted prompt
 */
function buildAutoDiscoveryPrompt(commandText, owner, repo, branch) {
  return `Repository: ${owner}/${repo}
Branch: ${branch}

You are an AI assistant tasked with generating and updating AGENTS.md files.

Execute the following command to scan the repository and generate/update AGENTS.md files:

${commandText}

IMPORTANT: You must return the results in a specific JSON format so the bot can process your changes.

Return a JSON object with the following structure:
{
  "summary": "Brief description of changes",
  "files": [
    {
      "path": "AGENTS.md",
      "content": "... full file content ...",
      "action": "created|updated|unchanged"
    },
    {
      "path": "src/lib/AGENTS.md",
      "content": "... full file content ...",
      "action": "created|updated|unchanged"
    }
  ]
}

Rules:
1. Scan the ENTIRE repository structure
2. Identify ALL existing AGENTS.md files
3. Determine if each needs to be updated
4. Create new AGENTS.md files where needed (root and important subdirectories)
5. For each file that needs changes, include the full new content
6. Only include files that have actual changes (action: "created" or "updated")
7. Return ONLY valid JSON, no other text, explanations, or markdown
8. The content must be the exact text that should be written to each file

Begin your response with the JSON object immediately, no preamble.`;
}

/**
 * Parse file updates from Z.ai API response
 * @param {string} responseContent - Response content from Z.ai
 * @param {Object} octokit - GitHub Octokit instance
 * @param {string} owner - Repository owner
 * @param {string} repo - Repository name
 * @param {string} targetBranch - Target branch
 * @param {Function} fetchFileContent - Function to fetch file content
 * @param {Object} logger - Logger instance
 * @returns {Promise<Array<Object>>} - Array of file update objects
 */
async function parseFileUpdatesFromResponse(responseContent, octokit, owner, repo, targetBranch, fetchFileContent, logger) {
  const fileUpdates = [];
  
  try {
    // Try to parse as JSON
    let parsed;
    try {
      // Remove any markdown code blocks if present
      const cleaned = responseContent.trim();
      const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        parsed = JSON.parse(jsonMatch[0]);
      } else {
        parsed = JSON.parse(cleaned);
      }
    } catch (e) {
      logger.warn('Could not parse response as JSON, attempting to extract file information');
      // Fallback: try to extract file paths and content from the response
      return await extractFilesFromText(responseContent, octokit, owner, repo, targetBranch, fetchFileContent, logger);
    }
    
    if (parsed && parsed.files && Array.isArray(parsed.files)) {
      // Process each file from the structured response
      for (const fileInfo of parsed.files) {
        const filePath = fileInfo.path || fileInfo.file;
        const newContent = fileInfo.content || fileInfo.body;
        const action = (fileInfo.action || '').toLowerCase();
        
        if (!filePath || !newContent) {
          logger.warn(`Skipping invalid file entry: ${JSON.stringify(fileInfo)}`);
          continue;
        }
        
        try {
          const currentContent = await fetchFileContent(octokit, owner, repo, filePath, targetBranch);
          const changed = action === 'created' || action === 'updated' || currentContent === null || currentContent !== newContent;
          
          if (changed) {
            fileUpdates.push({
              file: filePath,
              oldContent: currentContent,
              newContent,
              changed: true,
              isNew: currentContent === null,
            });
          } else {
            fileUpdates.push({
              file: filePath,
              changed: false,
            });
          }
        } catch (error) {
          logger.error({ error: error.message, file: filePath }, 'Failed to check file for auto-discovery');
          // Assume it needs to be created/updated
          fileUpdates.push({
            file: filePath,
            oldContent: null,
            newContent,
            changed: true,
            isNew: true,
          });
        }
      }
      
      logger.info(`Parsed ${fileUpdates.length} file updates from structured response`);
    } else {
      logger.warn('Response does not contain expected files array, attempting fallback');
      // Fallback: try to extract from text
      return await extractFilesFromText(responseContent, octokit, owner, repo, targetBranch, fetchFileContent, logger);
    }
    
  } catch (error) {
    logger.error({ error: error.message }, 'Failed to parse file updates from response');
    // Return empty array - caller will handle fallback
  }
  
  return fileUpdates;
}

/**
 * Fallback: Extract file information from plain text response
 * @param {string} text - Plain text response
 * @param {Object} octokit - GitHub Octokit instance
 * @param {string} owner - Repository owner
 * @param {string} repo - Repository name
 * @param {string} targetBranch - Target branch
 * @param {Function} fetchFileContent - Function to fetch file content
 * @param {Object} logger - Logger instance
 * @returns {Promise<Array<Object>>} - Array of file update objects
 */
async function extractFilesFromText(text, octokit, owner, repo, targetBranch, fetchFileContent, logger) {
  logger.warn('Attempting to extract file updates from plain text response');
  
  // This is a fallback for when the response isn't structured JSON
  // We'll just return the AGENTS.md file with the raw content
  // In a real implementation, the command should return proper JSON
  
  const filePath = 'AGENTS.md';
  const newContent = text;
  
  try {
    const currentContent = await fetchFileContent(octokit, owner, repo, filePath, targetBranch);
    const changed = currentContent === null || currentContent !== newContent;
    
    return [{
      file: filePath,
      oldContent: currentContent,
      newContent,
      changed,
      isNew: currentContent === null,
    }];
  } catch (error) {
    return [{
      file: filePath,
      oldContent: null,
      newContent,
      changed: true,
      isNew: true,
    }];
  }
}

/**
 * Build PR body with task information
 * @param {string} baseBody - Base PR body
 * @param {Array<string>} updatedFiles - List of updated files
 * @param {string} taskId - Task ID
 * @returns {string} - Full PR body
 */
function buildPrBody(baseBody, updatedFiles, taskId) {
  const timestamp = new Date().toISOString();
  const filesList = updatedFiles.map(f => `- ${f}`).join('\n');
  
  return `${baseBody}\n\n` +
         `**Task:** ${taskId}\n` +
         `**Timestamp:** ${timestamp}\n` +
         `**Files Updated:**\n${filesList}\n\n` +
         `---\n` +
         `*Generated automatically by zai-code-bot scheduled task*`;
}

// ============================================================================
// COMMAND EXECUTION
// ============================================================================

/**
 * Execute a command text to generate content
 * Sends the command to Z.ai API and returns the generated content
 * @param {Object} params - Execution parameters
 * @param {string} params.commandText - The command text to execute
 * @param {Object} params.octokit - GitHub Octokit instance
 * @param {string} params.apiKey - Z.ai API key
 * @param {string} params.model - Z.ai model
 * @param {string} params.owner - Repository owner
 * @param {string} params.repo - Repository name
 * @param {string} params.targetBranch - Target branch
 * @param {Object} params.logger - Logger instance
 * @returns {Promise<string>} - Generated content
 */
async function executeCommandAndGetContent(params) {
  const { commandText, apiKey, model, owner, repo, targetBranch, logger } = params;
  
  // If command text is empty, return empty
  if (!commandText || commandText.trim() === '') {
    logger.warn('Command text is empty, cannot execute');
    return commandText;
  }
  
  try {
    // Check if it's a valid /zai command
    const parseResult = parseCommand(commandText);
    
    if (isValid(parseResult)) {
      logger.info(`Executing /zai command: ${parseResult.command} with args: ${parseResult.args.join(' ')}`);
      
      // For /zai commands, we need to execute them through the dispatch system
      // But since we're not in a PR context, we'll use the Z.ai API directly
      const prompt = buildCommandPrompt(commandText, owner, repo, targetBranch);
      
      // Call Z.ai API to execute the command
      const response = await callZaiApiWithRetry(apiKey, model, prompt, logger);
      
      if (response && response.content) {
        return response.content;
      }
      
      logger.warn('Z.ai API returned empty content');
      return commandText;
    } else {
      // Not a /zai command - try to execute as a direct prompt
      logger.info('Command is not a /zai command, sending as direct prompt to Z.ai API');
      
      // Build a prompt that tells Z.ai to generate AGENTS.md content
      const prompt = buildAgentsGenerationPrompt(commandText, owner, repo);
      
      // Call Z.ai API
      const response = await callZaiApiWithRetry(apiKey, model, prompt, logger);
      
      if (response && response.content) {
        return response.content;
      }
      
      logger.warn('Z.ai API returned empty content for direct prompt');
      return commandText;
    }
  } catch (error) {
    logger.error({ error: error.message }, 'Failed to execute command for content generation');
    throw error;
  }
}

/**
 * Build prompt for executing a /zai command
 * @param {string} commandText - The command text
 * @param {string} owner - Repository owner
 * @param {string} repo - Repository name
 * @param {string} branch - Target branch
 * @returns {string} - Formatted prompt
 */
function buildCommandPrompt(commandText, owner, repo, branch) {
  return `Repository: ${owner}/${repo}
Branch: ${branch}

Execute the following command:
${commandText}

Return only the generated content (AGENTS.md file content), without any explanation or formatting.`;
}

/**
 * Build prompt for generating AGENTS.md from a direct prompt
 * @param {string} promptText - The prompt/command text
 * @param {string} owner - Repository owner
 * @param {string} repo - Repository name
 * @returns {string} - Formatted prompt
 */
function buildAgentsGenerationPrompt(promptText, owner, repo) {
  return `You are an AI assistant helping to generate AGENTS.md files for a repository.

Repository: ${owner}/${repo}

Task: Generate comprehensive AGENTS.md content based on the following instructions:

${promptText}

Return ONLY the generated AGENTS.md file content. Do not include any explanation, formatting notes, or markdown headers. Start directly with the content that should be written to the AGENTS.md file.`;
}

/**
 * Call Z.ai API with retry logic
 * @param {string} apiKey - Z.ai API key
 * @param {string} model - Model to use
 * @param {string} prompt - Prompt to send
 * @param {Object} logger - Logger instance
 * @param {number} retries - Number of retries (default: 3)
 * @returns {Promise<Object>} - API response
 */
async function callZaiApiWithRetry(apiKey, model, prompt, logger, retries = 3) {
  const https = require('node:https');
  const ZAI_API_URL = 'https://api.z.ai/api/coding/paas/v4/chat/completions';
  
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const body = JSON.stringify({
        model,
        messages: [
          {
            role: 'user',
            content: prompt,
          },
        ],
      });
      
      const parsedUrl = new URL(ZAI_API_URL);
      const options = {
        hostname: parsedUrl.hostname,
        path: parsedUrl.pathname,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`,
          'Content-Length': Buffer.byteLength(body),
        },
      };
      
      const response = await new Promise((resolve, reject) => {
        const req = https.request(options, res => {
          let data = '';
          res.on('data', chunk => (data += chunk));
          res.on('end', () => {
            if (res.statusCode >= 200 && res.statusCode < 300) {
              try {
                const parsed = JSON.parse(data);
                resolve(parsed);
              } catch (e) {
                reject(new Error(`Failed to parse response: ${e.message}`));
              }
            } else {
              reject(new Error(`API error ${res.statusCode}: ${data.substring(0, 200)}`));
            }
          });
        });
        
        req.on('error', reject);
        req.write(body);
        req.end();
      });
      
      return {
        content: response.choices?.[0]?.message?.content || '',
        fullResponse: response,
      };
    } catch (error) {
      logger.warn({ error: error.message, attempt }, `Z.ai API call failed, attempt ${attempt} of ${retries}`);
      
      if (attempt === retries) {
        throw error;
      }
      
      // Exponential backoff
      const delay = Math.pow(2, attempt) * 1000;
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }
}

// ============================================================================
// UTILITY FUNCTIONS
// ============================================================================

/**
 * Fetch content from a URL
 * @param {string} url - URL to fetch
 * @returns {Promise<string>} - Content as string
 */
async function fetchFromUrl(url) {
  return new Promise((resolve, reject) => {
    try {
      const parsedUrl = new URL(url);
      const options = {
        hostname: parsedUrl.hostname,
        path: parsedUrl.pathname + parsedUrl.search,
        method: 'GET',
        headers: {
          'User-Agent': 'zai-code-bot',
          'Accept': 'text/plain,text/html,application/json',
        },
      };
      
      logger.info(`Fetching URL: ${url}`);
      
      const req = https.request(options, res => {
        let data = '';
        res.on('data', chunk => (data += chunk));
        res.on('end', () => {
          if (res.statusCode >= 200 && res.statusCode < 300) {
            logger.info(`Fetched ${data.length} bytes from URL`);
            resolve(data);
          } else {
            reject(new Error(`HTTP ${res.statusCode}: ${data.substring(0, 200)}`));
          }
        });
      });
      
      req.on('error', reject);
      req.setTimeout(30000, () => {
        req.destroy(new Error('Request timeout after 30s'));
      });
      req.end();
    } catch (error) {
      reject(new Error(`Invalid URL: ${error.message}`));
    }
  });
}

/**
 * Fetch file content from repository
 * @param {Object} octokit - GitHub Octokit instance
 * @param {string} owner - Repository owner
 * @param {string} repo - Repository name
 * @param {string} path - File path
 * @param {string} ref - Branch/ref
 * @returns {Promise<string|null>} - File content or null if not found
 */
async function fetchFileContent(octokit, owner, repo, path, ref) {
  try {
    const { data } = await octokit.rest.repos.getContent({
      owner,
      repo,
      path,
      ref,
    });
    
    return Buffer.from(data.content, 'base64').toString('utf8');
  } catch (error) {
    if (error.status === 404) {
      return null;
    }
    throw error;
  }
}

/**
 * Get the SHA of a file in repository
 * @param {Object} octokit - GitHub Octokit instance
 * @param {string} owner - Repository owner
 * @param {string} repo - Repository name
 * @param {string} path - File path
 * @param {string} ref - Branch/ref
 * @returns {Promise<string|null>} - File SHA or null if not found
 */
async function getFileSha(octokit, owner, repo, path, ref) {
  try {
    const { data } = await octokit.rest.repos.getContent({
      owner,
      repo,
      path,
      ref,
    });
    return data.sha;
  } catch (error) {
    if (error.status === 404) {
      return null;
    }
    throw error;
  }
}

/**
 * Create or update file in repository
 * @param {Object} octokit - GitHub Octokit instance
 * @param {string} owner - Repository owner
 * @param {string} repo - Repository name
 * @param {string} path - File path
 * @param {string} content - New content
 * @param {string} ref - Branch/ref
 * @param {string} commitMessage - Commit message
 * @returns {Promise<Object>} - GitHub API response
 */
async function updateFileInRepo(octokit, owner, repo, path, content, ref, commitMessage) {
  const existingSha = await getFileSha(octokit, owner, repo, path, ref);
  
  const response = await octokit.rest.repos.createOrUpdateFileContents({
    owner,
    repo,
    path,
    message: commitMessage,
    content: Buffer.from(content).toString('base64'),
    sha: existingSha || undefined,
    branch: ref,
  });
  
  return response.data;
}

/**
 * Create a pull request with file changes
 * @param {Object} octokit - GitHub Octokit instance
 * @param {string} owner - Repository owner
 * @param {string} repo - Repository name
 * @param {Object} params - PR parameters
 * @param {string} params.title - PR title
 * @param {string} params.body - PR body
 * @param {string} params.base - Base branch
 * @param {Array<Object>} params.files - Files to update (each with path and content)
 * @param {string} params.commitMessage - Commit message
 * @returns {Promise<Object>} - PR creation result
 */
async function createPR(octokit, owner, repo, { title, body, base, files, commitMessage }) {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  const hours = String(now.getHours()).padStart(2, '0');
  const minutes = String(now.getMinutes()).padStart(2, '0');
  const branchName = `zai-scheduled/${year}.${month}.${day}_${hours}.${minutes}`;
  
  logger.info(`Creating branch ${branchName} from ${base}`);
  
  // Get the base branch reference
  const { data: baseRef } = await octokit.rest.git.getRef({
    owner,
    repo,
    ref: `heads/${base}`,
  });
  
  // Create a new branch
  try {
    await octokit.rest.git.createRef({
      owner,
      repo,
      ref: `refs/heads/${branchName}`,
      sha: baseRef.object.sha,
    });
    logger.info(`Created branch ${branchName}`);
  } catch (error) {
    if (error.status !== 422) { // Already exists
      throw error;
    }
    logger.info(`Branch ${branchName} already exists, reusing`);
  }
  
  // Apply all file changes to the new branch
  let commitSha = baseRef.object.sha;
  
  for (const file of files) {
    const { path, content } = file;
    
    logger.info(`Updating file ${path} in branch ${branchName}`);
    
    try {
      const result = await updateFileInRepo(
        octokit, 
        owner, 
        repo, 
        path, 
        content, 
        branchName,
        commitMessage
      );
      commitSha = result.commit.sha;
      logger.info(`Updated ${path} successfully`);
    } catch (error) {
      logger.error({ error: error.message, file: path }, 'Failed to update file in branch');
      throw error;
    }
  }
  
  // Create the pull request
  logger.info(`Creating pull request from ${branchName} to ${base}`);
  
  const prResponse = await octokit.rest.pulls.create({
    owner,
    repo,
    title,
    body,
    head: branchName,
    base,
  });
  
  logger.info(`Created PR #${prResponse.data.number}`);
  
  return {
    ...prResponse.data,
    commitSha,
  };
}

// ============================================================================
// EXPORTS
// ============================================================================

module.exports = {
  handleScheduledEvent,
  executeScheduledTask,
  getScheduledHandler,
  registerScheduledHandler,
  getAllScheduledHandlers,
  handleUpdateAgentsTask,
  // Export utility functions for testing and manual command integration
  fetchFromUrl,
  fetchFileContent,
  getFileSha,
  updateFileInRepo,
  createPR,
  buildExecutionContext,
};
