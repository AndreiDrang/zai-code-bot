/**
 * Scheduled Tasks Configuration Loader
 * 
 * Loads and validates .zai-scheduled.yml configuration files from repositories.
 * Provides schema validation and task filtering for scheduled execution.
 */

const yaml = require('yaml');

// Configuration schema version
const CONFIG_VERSION = 1;

/**
 * Default configuration values
 */
const DEFAULTS = {
  branch: 'main',
  schedule: '0 0 * * 0', // Weekly on Sunday at midnight UTC
  enabled: true,
};

/**
 * Get the Gist URL for AGENTS.md updates
 * Checks in order: task config, defaults, environment variable
 * @param {Object} taskConfig - Task configuration
 * @param {Object} defaults - Default configuration
 * @returns {string|null} - Gist URL or null
 */
function getGistUrl(taskConfig, defaults) {
  return taskConfig?.gist_url 
    || defaults?.gist_url 
    || process.env.ZAI_AGENTS_GIST_URL 
    || null;
}

/**
 * Load scheduled configuration from repository
 * @param {Object} octokit - GitHub Octokit instance
 * @param {string} owner - Repository owner
 * @param {string} repo - Repository name
 * @param {string} ref - Branch/ref to load from (default: main)
 * @returns {Promise<Object|null>} - Configuration object or null if not found
 */
async function loadScheduledConfig(octokit, owner, repo, ref = 'main') {
  try {
    const configPath = process.env.ZAI_SCHEDULED_CONFIG_PATH || '.zai-scheduled.yml';
    
    const { data: configContent } = await octokit.rest.repos.getContent({
      owner,
      repo,
      path: configPath,
      ref,
    });
    
    const rawContent = Buffer.from(configContent.content, 'base64').toString('utf8');
    const config = yaml.parse(rawContent);
    
    // Validate and normalize configuration
    return validateAndNormalizeConfig(config);
  } catch (error) {
    if (error.status === 404) {
      return null; // Config not found - scheduled tasks disabled
    }
    throw error;
  }
}

/**
 * Validate configuration schema and normalize values
 * @param {Object} config - Raw configuration object
 * @returns {Object} - Validated and normalized configuration
 * @throws {Error} - If configuration is invalid
 */
function validateAndNormalizeConfig(config) {
  // Check version
  if (!config.version) {
    throw new Error(`Configuration missing required field: version`);
  }
  
  if (config.version !== CONFIG_VERSION) {
    throw new Error(`Unsupported config version: ${config.version}. Expected: ${CONFIG_VERSION}`);
  }
  
  // Validate and normalize defaults
  config.defaults = validateDefaults(config.defaults || {});
  
  // Validate tasks
  if (!config.tasks || !Array.isArray(config.tasks)) {
    throw new Error('Configuration must contain a "tasks" array');
  }
  
  // Validate and normalize each task
  config.tasks = config.tasks.map((task, index) => {
    return validateAndNormalizeTask(task, index, config.defaults);
  });
  
  return config;
}

/**
 * Validate and normalize defaults section
 * @param {Object} defaults - Raw defaults object
 * @returns {Object} - Validated defaults
 * @throws {Error} - If defaults are invalid
 */
function validateDefaults(defaults) {
  const validated = { ...DEFAULTS, ...defaults };
  
  if (validated.branch && typeof validated.branch !== 'string') {
    throw new Error(`defaults.branch must be a string`);
  }
  
  if (validated.schedule && typeof validated.schedule !== 'string') {
    throw new Error(`defaults.schedule must be a string`);
  }
  
  if (validated.gist_url && typeof validated.gist_url !== 'string') {
    throw new Error(`defaults.gist_url must be a string`);
  }
  
  return validated;
}

/**
 * Validate and normalize a single task
 * @param {Object} task - Raw task object
 * @param {number} index - Task index for error reporting
 * @param {Object} defaults - Validated defaults
 * @returns {Object} - Validated and normalized task
 * @throws {Error} - If task is invalid
 */
function validateAndNormalizeTask(task, index, defaults) {
  if (!task.id) {
    throw new Error(`Task ${index} missing required field: id`);
  }
  
  if (typeof task.id !== 'string') {
    throw new Error(`Task ${index} field 'id' must be a string`);
  }
  
  if (!task.command) {
    throw new Error(`Task ${task.id} missing required field: command`);
  }
  
  if (typeof task.command !== 'string') {
    throw new Error(`Task ${task.id} field 'command' must be a string`);
  }
  
  // Validate enabled flag
  if (task.enabled !== undefined && typeof task.enabled !== 'boolean') {
    throw new Error(`Task ${task.id} has invalid enabled value (must be boolean)`);
  }
  
  // Apply defaults
  const normalized = {
    id: task.id,
    name: task.name || task.id,
    enabled: task.enabled !== undefined ? task.enabled : defaults.enabled,
    schedule: task.schedule || defaults.schedule,
    command: task.command,
    config: { ...defaults, ...task.config },
  };
  
  // Validate task-specific config
  if (normalized.config.branch && typeof normalized.config.branch !== 'string') {
    throw new Error(`Task ${task.id} has invalid branch value`);
  }
  
  if (normalized.config.gist_url && typeof normalized.config.gist_url !== 'string') {
    throw new Error(`Task ${task.id} has invalid gist_url value`);
  }
  
  if (normalized.config.files && !Array.isArray(normalized.config.files)) {
    throw new Error(`Task ${task.id} has invalid files value (must be array)`);
  }
  
  return normalized;
}

/**
 * Get tasks that should run for this schedule event
 * @param {Object} config - Validated configuration
 * @param {string} eventSchedule - Cron schedule from GitHub event context
 * @returns {Array<Object>} - Tasks to execute
 */
function getTasksToRun(config, eventSchedule) {
  const enabledTasks = config.tasks.filter(t => t.enabled === true);
  
  // If no enabled tasks, return empty array
  if (enabledTasks.length === 0) {
    return [];
  }
  
  // If event has specific schedule, only run tasks matching that schedule
  if (eventSchedule) {
    return enabledTasks.filter(t => {
      return t.schedule === eventSchedule || 
             (config.defaults?.schedule && t.schedule === config.defaults.schedule);
    });
  }
  
  // Otherwise run all enabled tasks
  return enabledTasks;
}

/**
 * Get a specific task by ID
 * @param {Object} config - Validated configuration
 * @param {string} taskId - Task ID to find
 * @returns {Object|null} - Task object or null if not found
 */
function getTaskById(config, taskId) {
  return config.tasks.find(t => t.id === taskId) || null;
}

/**
 * Check if scheduled tasks are enabled in this repository
 * @param {Object} octokit - GitHub Octokit instance
 * @param {string} owner - Repository owner
 * @param {string} repo - Repository name
 * @param {string} ref - Branch/ref to check (default: main)
 * @returns {Promise<boolean>} - True if scheduled tasks are enabled
 */
async function areScheduledTasksEnabled(octokit, owner, repo, ref = 'main') {
  const config = await loadScheduledConfig(octokit, owner, repo, ref);
  return config !== null;
}

module.exports = {
  CONFIG_VERSION,
  loadScheduledConfig,
  validateAndNormalizeConfig,
  getTasksToRun,
  getTaskById,
  areScheduledTasksEnabled,
  getGistUrl,
  // Export for testing
  validateDefaults,
  validateAndNormalizeTask,
};
