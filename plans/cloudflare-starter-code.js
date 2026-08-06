/**
 * Zai Code Bot - Cloudflare Computer Starter Code
 * 
 * Это базовый шаблон для миграции с GitHub Actions на Cloudflare Computer
 * Содержит основные компоненты для обработки GitHub событий
 */

// ============================================================================
// 1. ИМПОРТЫ
// ============================================================================

import { Computer } from '@cloudflare/computer';
import { createLogger } from './lib/logging.js';
import { GitHubClient } from './lib/github.js';
import { ZaiApiClient } from './lib/api.js';
import { parseCommand } from './lib/commands.js';
import { handlers } from './lib/handlers/index.js';

// ============================================================================
// 2. КОНСТАНТЫ
// ============================================================================

const GITHUB_WEBHOOK_SECRET = 'GITHUB_WEBHOOK_SECRET';
const ZAI_API_KEY = 'ZAI_API_KEY';
const GITHUB_TOKEN = 'GITHUB_TOKEN';
const ZAI_MODEL = 'ZAI_MODEL';

const COMMENT_MARKER = '<!-- zai-code-review -->';
const PROGRESS_MARKER = '<!-- zai-progress -->';

// Конфигурации изолятов
const ISOLATE_CONFIGS = {
  command: {
    memory: '256MB',
    cpu: '50ms',
    timeout: '60s',
    filesystem: { '/repo': { size: '1GB' }, '/tmp': { size: '256MB' } }
  },
  review: {
    memory: '512MB',
    cpu: '100ms',
    timeout: '120s',
    filesystem: { '/repo': { size: '2GB' }, '/tmp': { size: '512MB' } }
  },
  analysis: {
    memory: '1GB',
    cpu: '200ms',
    timeout: '180s',
    filesystem: { '/repo': { size: '4GB' }, '/tmp': { size: '1GB' } }
  }
};

// ============================================================================
// 3. ВСПОМОГАТЕЛЬНЫЕ ФУНКЦИИ
// ============================================================================

/**
 * Парсит GitHub webhook payload
 */
function parseGitHubWebhook(request) {
  const payload = request.body;
  const headers = request.headers;
  
  // GitHub отправляет событие в заголовке
  const event = headers.get('x-github-event');
  
  // Парсим JSON payload
  try {
    const body = JSON.parse(payload);
    
    return {
      event,
      action: body.action,
      repository: body.repository,
      pull_request: body.pull_request,
      issue: body.issue,
      comment: body.comment,
      sender: body.sender,
      installation: body.installation
    };
  } catch (e) {
    throw new Error(`Failed to parse GitHub webhook: ${e.message}`);
  }
}

/**
 * Проверяет подпись GitHub webhook
 */
async function verifyGitHubSignature(request, env) {
  const signature = request.headers.get('x-hub-signature-256');
  const payload = await request.text();
  
  if (!signature || !env[GITHUB_WEBHOOK_SECRET]) {
    return false;
  }
  
  const hmac = crypto.createHmac('sha256', env[GITHUB_WEBHOOK_SECRET]);
  hmac.update(payload);
  const expectedSignature = `sha256=${hmac.digest('hex')}`;
  
  return crypto.timingSafeEqual(
    Buffer.from(signature),
    Buffer.from(expectedSignature)
  );
}

/**
 * Определяет тип события
 */
function getEventType(githubEvent, action, pull_request, issue) {
  if (githubEvent === 'pull_request') {
    return `pull_request_${action}`;
  }
  
  if (githubEvent === 'issue_comment') {
    if (issue && issue.pull_request) {
      return 'pull_request_comment';
    }
    return 'issue_comment';
  }
  
  if (githubEvent === 'pull_request_review_comment') {
    return 'pull_request_review_comment';
  }
  
  if (githubEvent === 'schedule') {
    return 'schedule';
  }
  
  return githubEvent;
}

/**
 * Проверяет, нужно ли обрабатывать событие
 */
function shouldProcessEvent(eventType, commentBody) {
  // Всегда обрабатываем PR события
  if (eventType.startsWith('pull_request_')) {
    const validActions = ['opened', 'synchronize', 'reopened', 'ready_for_review'];
    const action = eventType.replace('pull_request_', '');
    return validActions.includes(action);
  }
  
  // Обрабатываем комментарии с командами /zai
  if (eventType === 'issue_comment' || eventType === 'pull_request_comment') {
    return commentBody && (commentBody.includes('/zai') || commentBody.includes('@zai-bot'));
  }
  
  // Обрабатываем PR review комментарии
  if (eventType === 'pull_request_review_comment') {
    return true;
  }
  
  // Обрабатываем запланированные задачи
  if (eventType === 'schedule') {
    return true;
  }
  
  return false;
}

// ============================================================================
// 4. ОСНОВНЫЕ ОБРАБОТЧИКИ
// ============================================================================

/**
 * Обработка Pull Request событий
 */
async function handlePullRequest(computer, env, { repository, pull_request, eventType }) {
  const logger = createLogger(env);
  logger.info(`Processing PR event: ${eventType}`, { 
    repo: repository.full_name, 
    pr: pull_request.number 
  });
  
  // Создаём изолят для обработки PR
  const isolate = await computer.isolate.create({
    ...ISOLATE_CONFIGS.review,
    env: {
      REPOSITORY: JSON.stringify(repository),
      PULL_REQUEST: JSON.stringify(pull_request),
      EVENT: eventType,
      [ZAI_API_KEY]: env[ZAI_API_KEY],
      [GITHUB_TOKEN]: env[GITHUB_TOKEN],
      [ZAI_MODEL]: env[ZAI_MODEL] || 'glm-5.2'
    }
  });
  
  try {
    // Клонируем репозиторий
    const github = new GitHubClient(env[GITHUB_TOKEN]);
    await github.cloneRepository(isolate, repository, pull_request);
    
    // Получаем изменённые файлы
    const changedFiles = await github.getChangedFiles(
      repository.owner.login,
      repository.name,
      pull_request.number
    );
    
    // Анализируем изменения
    const zai = new ZaiApiClient(env[ZAI_API_KEY], env[ZAI_MODEL]);
    const review = await analyzePullRequest(isolate, zai, changedFiles, pull_request);
    
    // Публикуем комментарий с ревью
    if (review && review.comments && review.comments.length > 0) {
      await github.postReviewComment(
        repository.owner.login,
        repository.name,
        pull_request.number,
        formatReviewComments(review.comments)
      );
    }
    
    logger.info('PR review completed', { 
      repo: repository.full_name, 
      pr: pull_request.number,
      comments: review?.comments?.length || 0 
    });
    
    return new Response(JSON.stringify({ 
      status: 'completed', 
      review 
    }), { 
      headers: { 'Content-Type': 'application/json' } 
    });
    
  } catch (error) {
    logger.error('Error processing PR:', error);
    
    // Публикуем ошибку в PR
    const github = new GitHubClient(env[GITHUB_TOKEN]);
    await github.postComment(
      repository.owner.login,
      repository.name,
      pull_request.number,
      `## ❌ Z.ai Code Review Error

An error occurred while processing this pull request:

\`\`\`
${error.message}
\`\`\`

${COMMENT_MARKER}`
    );
    
    return new Response(JSON.stringify({ 
      status: 'error', 
      error: error.message 
    }), { 
      status: 500,
      headers: { 'Content-Type': 'application/json' } 
    });
  } finally {
    // Удаляем изолят
    await isolate.delete();
  }
}

/**
 * Обработка комментариев в Issues/PR
 */
async function handleIssueComment(computer, env, { repository, issue, comment }) {
  const logger = createLogger(env);
  
  // Парсим команду
  const command = parseCommand(comment.body);
  
  if (!command || !command.isValid) {
    logger.info('Not a zai command, skipping');
    return new Response('Not a zai command', { status: 200 });
  }
  
  logger.info(`Processing command: ${command.type}`, { 
    repo: repository.full_name, 
    issue: issue.number,
    user: comment.user.login 
  });
  
  // Проверяем авторизацию
  const github = new GitHubClient(env[GITHUB_TOKEN]);
  const isAuthorized = await github.checkAuthorization(
    repository.owner.login,
    repository.name,
    comment.user.login
  );
  
  if (!isAuthorized) {
    await github.postComment(
      repository.owner.login,
      repository.name,
      issue.number,
      getUnauthorizedMessage(comment.user.login, repository)
    );
    
    return new Response('Unauthorized', { status: 403 });
  }
  
  // Получаем обработчик команды
  const handler = handlers[command.type];
  
  if (!handler) {
    await github.postComment(
      repository.owner.login,
      repository.name,
      issue.number,
      `## ❌ Unknown Command

Unknown command: \`/zai ${command.type}\`

Use \`/zai help\` to see available commands.

${COMMENT_MARKER}`
    );
    
    return new Response(`Unknown command: ${command.type}`, { status: 400 });
  }
  
  // Создаём изолят для обработки команды
  const isolate = await computer.isolate.create({
    ...ISOLATE_CONFIGS.command,
    env: {
      REPOSITORY: JSON.stringify(repository),
      ISSUE: JSON.stringify(issue),
      COMMENT: JSON.stringify(comment),
      COMMAND: JSON.stringify(command),
      [ZAI_API_KEY]: env[ZAI_API_KEY],
      [GITHUB_TOKEN]: env[GITHUB_TOKEN],
      [ZAI_MODEL]: env[ZAI_MODEL] || 'glm-5.2'
    }
  });
  
  try {
    // Если нужно, клонируем репозиторий
    if (handler.requiresRepo) {
      await github.cloneRepository(isolate, repository);
    }
    
    // Выполняем обработчик
    const zai = new ZaiApiClient(env[ZAI_API_KEY], env[ZAI_MODEL]);
    const result = await handler.execute(isolate, zai, {
      repository,
      issue,
      comment,
      command
    });
    
    // Публикуем результат
    if (result.response) {
      await github.postComment(
        repository.owner.login,
        repository.name,
        issue.number,
        result.response
      );
    }
    
    logger.info('Command processed', { 
      repo: repository.full_name, 
      issue: issue.number,
      command: command.type 
    });
    
    return new Response(JSON.stringify(result), { 
      headers: { 'Content-Type': 'application/json' } 
    });
    
  } catch (error) {
    logger.error('Error processing command:', error);
    
    await github.postComment(
      repository.owner.login,
      repository.name,
      issue.number,
      `## ❌ Command Error

An error occurred while processing \`/zai ${command.type}\`:

\`\`\`
${error.message}
\`\`\`

${COMMENT_MARKER}`
    );
    
    return new Response(JSON.stringify({ 
      status: 'error', 
      error: error.message 
    }), { 
      status: 500,
      headers: { 'Content-Type': 'application/json' } 
    });
  } finally {
    await isolate.delete();
  }
}

/**
 * Обработка PR review комментариев
 */
async function handleReviewComment(computer, env, { repository, pull_request, comment }) {
  // Аналогично handleIssueComment, но для PR review comments
  // Можно использовать ту же логику, но с другим контекстом
  return handleIssueComment(computer, env, {
    repository,
    issue: pull_request,
    comment
  });
}

/**
 * Обработка запланированных задач
 */
async function handleScheduledTask(computer, env, { repository, schedule }) {
  const logger = createLogger(env);
  logger.info('Processing scheduled task', { schedule });
  
  // Создаём изолят для запланированной задачи
  const isolate = await computer.isolate.create({
    ...ISOLATE_CONFIGS.analysis,
    env: {
      REPOSITORY: JSON.stringify(repository),
      SCHEDULE: JSON.stringify(schedule),
      [ZAI_API_KEY]: env[ZAI_API_KEY],
      [GITHUB_TOKEN]: env[GITHUB_TOKEN],
      [ZAI_MODEL]: env[ZAI_MODEL] || 'glm-5.2'
    }
  });
  
  try {
    const github = new GitHubClient(env[GITHUB_TOKEN]);
    const zai = new ZaiApiClient(env[ZAI_API_KEY], env[ZAI_MODEL]);
    
    // Выполняем запланированную задачу
    const result = await handleScheduledEvent(isolate, zai, github, {
      repository,
      schedule
    });
    
    logger.info('Scheduled task completed', { result });
    
    return new Response(JSON.stringify({ 
      status: 'completed', 
      result 
    }), { 
      headers: { 'Content-Type': 'application/json' } 
    });
    
  } catch (error) {
    logger.error('Error processing scheduled task:', error);
    
    return new Response(JSON.stringify({ 
      status: 'error', 
      error: error.message 
    }), { 
      status: 500,
      headers: { 'Content-Type': 'application/json' } 
    });
  } finally {
    await isolate.delete();
  }
}

// ============================================================================
// 5. АНАЛИЗ PR
// ============================================================================

/**
 * Анализирует Pull Request изменения
 */
async function analyzePullRequest(isolate, zai, files, pullRequest) {
  // Фильтруем файлы с изменениями
  const changedFiles = files.filter(f => f.patch);
  
  if (changedFiles.length === 0) {
    return { comments: [] };
  }
  
  // Проверяем, большой ли PR
  const isLargePr = changedFiles.length > 50 || 
    changedFiles.reduce((sum, f) => sum + (f.patch?.length || 0), 0) > 120000;
  
  if (isLargePr) {
    return await processLargePr(isolate, zai, changedFiles, pullRequest);
  }
  
  return await processRegularPr(isolate, zai, changedFiles, pullRequest);
}

/**
 * Обработка обычного PR
 */
async function processRegularPr(isolate, zai, files, pullRequest) {
  const prompt = buildReviewPrompt(files, pullRequest);
  
  const review = await zai.chat(prompt, getReviewSystemPrompt());
  
  // Парсим ответ
  const comments = parseReviewResponse(review, files);
  
  return { comments };
}

/**
 * Обработка большого PR (батчами)
 */
async function processLargePr(isolate, zai, files, pullRequest) {
  const batches = createBatches(files);
  const allComments = [];
  
  for (const batch of batches) {
    const batchPrompt = buildBatchReviewPrompt(batch, pullRequest);
    const batchReview = await zai.chat(batchPrompt, getReviewSystemPrompt());
    const batchComments = parseReviewResponse(batchReview, batch);
    allComments.push(...batchComments);
  }
  
  // Синтезируем общий отчёт
  const synthesis = await synthesizeReviews(zai, allComments, pullRequest);
  
  return { comments: allComments, synthesis };
}

/**
 * Создаёт батчи файлов
 */
function createBatches(files) {
  const batches = [];
  let currentBatch = [];
  let currentSize = 0;
  
  for (const file of files) {
    const fileSize = file.patch?.length || 0;
    
    if (currentBatch.length >= 40 || currentSize + fileSize > 120000) {
      batches.push(currentBatch);
      currentBatch = [];
      currentSize = 0;
    }
    
    currentBatch.push(file);
    currentSize += fileSize;
  }
  
  if (currentBatch.length > 0) {
    batches.push(currentBatch);
  }
  
  return batches;
}

/**
 * Создаёт prompt для ревью
 */
function buildReviewPrompt(files, pullRequest) {
  const fileContents = files
    .map(f => `<file name="${f.filename}">\n<diff>\n${f.patch}\n</diff>\n</file>`)
    .join('\n\n');
  
  return `Please review the following Pull Request changes:

<pull_request>
Title: ${pullRequest.title}
Description: ${pullRequest.body || 'No description'}
Author: ${pullRequest.user.login}
Base: ${pullRequest.base.ref}
Head: ${pullRequest.head.ref}
</pull_request>

<changes>
${fileContents}
</changes>

Provide a detailed code review focusing on:
1. Bugs and logical errors
2. Security vulnerabilities (injections, unvalidated input, etc.)
3. Performance bottlenecks
4. Code quality and best practices
5. Architecture and design issues

Format your response as JSON with the following structure:
{
  "summary": "Overall assessment of the PR",
  "comments": [
    {
      "file": "filename",
      "line": 123,
      "type": "bug|security|performance|quality|architecture",
      "severity": "critical|high|medium|low",
      "message": "Detailed comment about the issue"
    }
  ]
}`;
}

/**
 * Системный prompt для ревью
 */
function getReviewSystemPrompt() {
  return `You are an Elite Staff Engineer and meticulous Code Reviewer. 
Your objective is to thoroughly analyze Pull Request diffs, identify potential 
bugs, security vulnerabilities, and architectural flaws, and provide 
constructive, actionable feedback.

### Core Instructions:
1. **Focus on Impact:** Prioritize logic errors, security risks, performance 
   bottlenecks, and bad practices.
2. **Be Specific:** Reference exact lines, files, and code snippets.
3. **Provide Solutions:** Don't just point out problems; suggest improvements.
4. **JSON Format:** Always respond in valid JSON format as specified.
5. **Severity Levels:** Use critical, high, medium, low appropriately.

### Security Focus:
- SQL injection vulnerabilities
- XSS vulnerabilities
- Unvalidated user input
- Hardcoded secrets
- Insecure dependencies
- Authentication/authorization issues

### Performance Focus:
- N+1 queries
- Inefficient algorithms
- Memory leaks
- Blocking operations
- Unnecessary computations

### Code Quality Focus:
- Readability and maintainability
- Proper error handling
- Consistent style
- Good naming conventions
- Appropriate comments`;
}

/**
 * Парсит ответ от Z.ai
 */
function parseReviewResponse(response, files) {
  try {
    const parsed = JSON.parse(response);
    return parsed.comments || [];
  } catch (e) {
    // Если не JSON, пытаемся парсить как текст
    return parseTextResponse(response, files);
  }
}

/**
 * Парсит текстовый ответ
 */
function parseTextResponse(response, files) {
  const comments = [];
  const lines = response.split('\n');
  
  let currentFile = null;
  let currentLine = null;
  
  for (const line of lines) {
    // Пытаемся найти файл и строку
    const fileMatch = line.match(/^File: (.+)$/);
    const lineMatch = line.match(/^Line: (\d+)$/);
    const typeMatch = line.match(/^Type: (.+)$/);
    const severityMatch = line.match(/^Severity: (.+)$/);
    const messageMatch = line.match(/^Message: (.+)$/);
    
    if (fileMatch) {
      currentFile = fileMatch[1];
    } else if (lineMatch) {
      currentLine = parseInt(lineMatch[1]);
    } else if (typeMatch && severityMatch && messageMatch) {
      if (currentFile) {
        comments.push({
          file: currentFile,
          line: currentLine || 1,
          type: typeMatch[1],
          severity: severityMatch[1],
          message: messageMatch[1]
        });
      }
    }
  }
  
  return comments;
}

/**
 * Синтезирует отчёт
 */
async function synthesizeReviews(zai, comments, pullRequest) {
  const synthesisPrompt = `Synthesize the following code review comments into a summary:

Comments:
${JSON.stringify(comments, null, 2)}

Pull Request: ${pullRequest.title}
Author: ${pullRequest.user.login}

Provide a concise summary (3-5 sentences) of the main issues found, 
if any. If no major issues, say so.`;
  
  return await zai.chat(synthesisPrompt);
}

/**
 * Форматирует комментарии для GitHub
 */
function formatReviewComments(comments) {
  if (!comments || comments.length === 0) {
    return `## ✅ Z.ai Code Review

No major issues found! The code looks good to merge.

${COMMENT_MARKER}`;
  }
  
  const groupedComments = {};
  
  // Группируем комментарии по файлам
  for (const comment of comments) {
    if (!groupedComments[comment.file]) {
      groupedComments[comment.file] = [];
    }
    groupedComments[comment.file].push(comment);
  }
  
  let response = `## 🔍 Z.ai Code Review

`;
  
  // Добавляем synthesis если есть
  // ...
  
  // Добавляем комментарии по файлам
  for (const [filename, fileComments] of Object.entries(groupedComments)) {
    response += `### 📄 ${filename}\n\n`;
    
    for (const comment of fileComments) {
      const severityEmoji = {
        critical: '🔴',
        high: '🟠',
        medium: '🟡',
        low: '🔵'
      }[comment.severity] || '⚪';
      
      response += `${severityEmoji} **${comment.type}** (Line ${comment.line}): ${comment.message}\n\n`;
    }
    
    response += '\n';
  }
  
  response += `---\n\n`;
  response += `_This is an automated code review powered by [Z.ai](https://z.ai)._\n`;
  response += `${COMMENT_MARKER}`;
  
  return response;
}

// ============================================================================
// 6. ГЛАВНЫЙ ЭКСПОРТ
// ============================================================================

/**
 * Основной обработчик Cloudflare Worker
 */
export default {
  async fetch(request, env, ctx) {
    const logger = createLogger(env);
    const computer = new Computer(env);
    
    try {
      // Парсим webhook
      const { event, action, repository, pull_request, issue, comment, sender } = 
        parseGitHubWebhook(request);
      
      // Проверяем подпись
      const isValid = await verifyGitHubSignature(request, env);
      
      if (!isValid) {
        logger.warn('Invalid GitHub signature');
        return new Response('Unauthorized', { status: 401 });
      }
      
      // Определяем тип события
      const eventType = getEventType(event, action, pull_request, issue);
      
      // Проверяем, нужно ли обрабатывать
      if (!shouldProcessEvent(eventType, comment?.body)) {
        logger.info('Skipping event', { eventType });
        return new Response('OK', { status: 200 });
      }
      
      logger.info('Processing event', { eventType, repo: repository?.full_name });
      
      // Маршрутизация событий
      switch (eventType) {
        case 'pull_request_opened':
        case 'pull_request_synchronize':
        case 'pull_request_reopened':
        case 'pull_request_ready_for_review':
          return handlePullRequest(computer, env, {
            repository,
            pull_request,
            eventType
          });
          
        case 'issue_comment':
        case 'pull_request_comment':
          return handleIssueComment(computer, env, {
            repository,
            issue: issue || pull_request,
            comment
          });
          
        case 'pull_request_review_comment':
          return handleReviewComment(computer, env, {
            repository,
            pull_request,
            comment
          });
          
        case 'schedule':
          return handleScheduledTask(computer, env, {
            repository,
            schedule: comment || {}
          });
          
        default:
          logger.info(`Unknown event type: ${eventType}`);
          return new Response('OK', { status: 200 });
      }
      
    } catch (error) {
      logger.error('Error processing request:', error);
      return new Response('Internal Server Error', { status: 500 });
    }
  },
  
  // Обработка запланированных задач (Cron)
  async scheduled(event, env, ctx) {
    const computer = new Computer(env);
    const logger = createLogger(env);
    
    logger.info('Processing scheduled event', { event: event.cron });
    
    // Для запланированных задач нужно получить информацию о репозитории
    // Это можно сделать через GitHub API или из конфигурации
    return handleScheduledTask(computer, env, {
      schedule: event
    });
  }
};

// ============================================================================
// 7. ЭКСПОРТ ДЛЯ ТЕСТИРОВАНИЯ
// ============================================================================

export {
  parseGitHubWebhook,
  verifyGitHubSignature,
  getEventType,
  shouldProcessEvent,
  handlePullRequest,
  handleIssueComment,
  handleReviewComment,
  handleScheduledTask,
  analyzePullRequest,
  ISOLATE_CONFIGS
};
