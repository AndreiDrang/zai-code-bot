# Техническая архитектура zai-code-bot на Cloudflare Computer

## 🏗️ Общая архитектура

### Компоненты системы

```
┌─────────────────────────────────────────────────────────────────────────┐
│                        Cloudflare Network                                 │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  ┌─────────────────┐    ┌─────────────────┐    ┌─────────────────────┐ │
│  │  GitHub          │    │  Cloudflare      │    │  Z.ai API            │ │
│  │  Webhooks        │───▶│  Workers         │───▶│  (Chat, Coding)      │ │
│  └─────────────────┘    │  (Entry Point)   │    └─────────────────────┘ │
│                         └────────┬────────┘                              │
│                                          │                                      │
│                         ┌────────────────┴────────────────┐              │
│                         │         Computer API            │              │
│                         ├──────────────────────────────────┤              │
│                         │  ┌─────────────┐  ┌─────────────┐ │              │
│                         │  │   Isolate   │  │  Container   │ │              │
│                         │  │  (Light)    │  │  (Heavy)     │ │              │
│                         │  └─────────────┘  └─────────────┘ │              │
│                         └──────────────────────────────────┘              │
│                                                                             │
│  ┌─────────────────────────────────────────────────────────────────┐   │
│  │                        KV Storage                              │   │
│  │  - Secrets          - Configuration      - Cache               │   │
│  └─────────────────────────────────────────────────────────────────┘   │
│                                                                             │
│  ┌─────────────────────────────────────────────────────────────────┐   │
│  │                        Durable Objects                          │   │
│  │  - Session State      - Rate Limiting      - Queue Management   │   │
│  └─────────────────────────────────────────────────────────────────┘   │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────┘
```

## 🎯 Детальная архитектура

### 1. Entry Point (Cloudflare Worker)

Основной файл: `src/index.js`

```javascript
import { Computer } from '@cloudflare/computer';
import { handleGitHubEvent } from './handlers/github.js';
import { createApiClient } from './lib/api.js';
import { createLogger } from './lib/logging.js';

const computer = new Computer({
  // Конфигурация по умолчанию
  defaultIsolate: {
    memory: '256MB',
    cpu: '50ms',
    timeout: '60s'
  },
  defaultContainer: {
    memory: '4GB',
    cpu: '200ms',
    timeout: '10m'
  }
});

export default {
  async fetch(request, env, ctx) {
    const logger = createLogger(env);
    
    try {
      // Парсим GitHub webhook
      const { action, repository, pull_request, issue, comment } = 
        await parseGitHubWebhook(request);
      
      // Проверяем подпись
      const isValid = verifyGitHubSignature(
        request,
        env.GITHUB_WEBHOOK_SECRET
      );
      
      if (!isValid) {
        return new Response('Unauthorized', { status: 401 });
      }
      
      // Маршрутизация событий
      const eventType = getEventType(action, pull_request, issue);
      
      switch (eventType) {
        case 'pull_request_opened':
        case 'pull_request_synchronize':
        case 'pull_request_reopened':
        case 'pull_request_ready_for_review':
          return handlePullRequest(computer, env, {
            repository,
            pull_request,
            event: eventType
          });
          
        case 'issue_comment_created':
          return handleIssueComment(computer, env, {
            repository,
            issue,
            comment
          });
          
        case 'pull_request_review_comment_created':
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
    return handleScheduledTask(computer, env, {
      type: event.cron,
      scheduledTime: event.scheduledTime
    });
  }
};
```

### 2. Обработчики событий

#### 2.1 Обработка Pull Request

**Файл:** `src/handlers/pull-request.js`

```javascript
import { createIsolate } from '../lib/computer.js';
import { cloneRepository } from '../lib/git.js';
import { analyzeChanges } from '../lib/auto-review.js';
import { postReviewComment } from '../lib/github.js';

export async function handlePullRequest(computer, env, { repository, pull_request, event }) {
  const logger = createLogger(env);
  
  // Создаём изолят для обработки PR
  const isolate = await computer.isolate.create({
    memory: '512MB',
    cpu: '100ms',
    timeout: '120s',
    filesystem: {
      '/repo': { size: '2GB' },
      '/tmp': { size: '512MB' }
    },
    env: {
      REPOSITORY: JSON.stringify(repository),
      PULL_REQUEST: JSON.stringify(pull_request),
      EVENT: event,
      ZAI_API_KEY: env.ZAI_API_KEY,
      GITHUB_TOKEN: env.GITHUB_TOKEN,
      ZAI_MODEL: env.ZAI_MODEL || 'glm-5.2'
    }
  });
  
  // Клонируем репозиторий в изоляте
  await cloneRepository(isolate, repository);
  
  // Получаем изменённые файлы
  const changedFiles = await getChangedFiles(isolate, {
    owner: repository.owner.login,
    repo: repository.name,
    pullNumber: pull_request.number
  });
  
  // Анализируем изменения
  const review = await analyzeChanges(isolate, {
    files: changedFiles,
    pullRequest: pull_request
  });
  
  // Публикуем комментарий с ревью
  if (review.comments && review.comments.length > 0) {
    await postReviewComment(isolate, {
      owner: repository.owner.login,
      repo: repository.name,
      pullNumber: pull_request.number,
      comments: review.comments
    });
  }
  
  // Возвращаем результат
  return new Response(JSON.stringify({
    status: 'completed',
    review
  }), {
    headers: { 'Content-Type': 'application/json' }
  });
}
```

#### 2.2 Обработка комментариев

**Файл:** `src/handlers/comments.js`

```javascript
import { parseCommand } from '../lib/commands.js';
import { handlers } from '../lib/handlers/index.js';

export async function handleIssueComment(computer, env, { repository, issue, comment }) {
  // Проверяем, что комментарий содержит команду
  const command = parseCommand(comment.body);
  
  if (!command || !command.isValid) {
    return new Response('Not a zai command', { status: 200 });
  }
  
  // Маршрутизация команд
  const handler = handlers[command.type];
  
  if (!handler) {
    return new Response(`Unknown command: ${command.type}`, { status: 400 });
  }
  
  // Создаём изолят для обработки команды
  const isolate = await computer.isolate.create({
    memory: '256MB',
    cpu: '50ms',
    timeout: '60s',
    filesystem: {
      '/repo': { size: '1GB' }
    },
    env: {
      REPOSITORY: JSON.stringify(repository),
      ISSUE: JSON.stringify(issue),
      COMMENT: JSON.stringify(comment),
      COMMAND: JSON.stringify(command),
      ZAI_API_KEY: env.ZAI_API_KEY,
      GITHUB_TOKEN: env.GITHUB_TOKEN,
      ZAI_MODEL: env.ZAI_MODEL
    }
  });
  
  // Клонируем репозиторий (если нужно)
  if (handler.requiresRepo) {
    await cloneRepository(isolate, repository);
  }
  
  // Выполняем обработчик
  const result = await handler.execute(isolate, {
    repository,
    issue,
    comment,
    command
  });
  
  // Публикуем результат
  if (result.response) {
    await postComment(isolate, {
      owner: repository.owner.login,
      repo: repository.name,
      issueNumber: issue.number,
      body: result.response
    });
  }
  
  return new Response(JSON.stringify(result), {
    headers: { 'Content-Type': 'application/json' }
  });
}

export async function handleReviewComment(computer, env, { repository, pull_request, comment }) {
  // Аналогично handleIssueComment, но для PR review comments
  // ...
}
```

### 3. Работа с GitHub API

**Файл:** `src/lib/github.js`

```javascript
import { createLogger } from './logging.js';

const GITHUB_API_BASE = 'https://api.github.com';

export class GitHubClient {
  constructor(token) {
    this.token = token;
    this.logger = createLogger({ context: 'GitHubClient' });
  }
  
  async request(method, path, data = null) {
    const url = `${GITHUB_API_BASE}${path}`;
    
    const options = {
      method,
      headers: {
        'Authorization': `token ${this.token}`,
        'Accept': 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'zai-code-bot'
      }
    };
    
    if (data) {
      options.body = JSON.stringify(data);
    }
    
    const response = await fetch(url, options);
    
    if (!response.ok) {
      const error = await response.text();
      this.logger.error(`GitHub API error: ${response.status} ${error}`);
      throw new Error(`GitHub API error: ${response.status}`);
    }
    
    return response.json();
  }
  
  async getPullRequest(owner, repo, pullNumber) {
    return this.request(
      'GET',
      `/repos/${owner}/${repo}/pulls/${pullNumber}`
    );
  }
  
  async getChangedFiles(owner, repo, pullNumber) {
    const pr = await this.getPullRequest(owner, repo, pullNumber);
    const files = [];
    let page = 1;
    
    while (true) {
      const response = await this.request(
        'GET',
        `/repos/${owner}/${repo}/pulls/${pullNumber}/files?page=${page}&per_page=100`
      );
      
      if (!response.length) break;
      
      files.push(...response);
      page++;
      
      if (response.length < 100) break;
    }
    
    return files;
  }
  
  async postComment(owner, repo, issueNumber, body) {
    return this.request(
      'POST',
      `/repos/${owner}/${repo}/issues/${issueNumber}/comments`,
      { body }
    );
  }
  
  async postReviewComment(owner, repo, pullNumber, comments) {
    // Создаём или обновляем review комментарий
    // ...
  }
  
  async cloneRepository(isolate, repository) {
    // Клонируем репозиторий в изолированную ФС
    const command = `git clone --depth 1 https://x-access-token:${this.token}@github.com/${repository.full_name}.git /repo`;
    
    await isolate.run(command);
    
    // Переходим в директорию репозитория
    await isolate.run('cd /repo');
    
    // Устанавливаем нужный коммит (для PR)
    // ...
  }
}
```

### 4. Работа с Z.ai API

**Файл:** `src/lib/api.js`

```javascript
import { createLogger } from './logging.js';

const ZAI_API_URL = 'https://api.z.ai/api/coding/paas/v4/chat/completions';

export class ZaiApiClient {
  constructor(apiKey, model = 'glm-5.2') {
    this.apiKey = apiKey;
    this.model = model;
    this.logger = createLogger({ context: 'ZaiApiClient' });
  }
  
  async chat(prompt, systemPrompt = null, options = {}) {
    const payload = {
      model: this.model,
      messages: [
        {
          role: 'system',
          content: systemPrompt || this.getDefaultSystemPrompt()
        },
        {
          role: 'user',
          content: prompt
        }
      ],
      stream: false,
      ...options
    };
    
    const response = await fetch(ZAI_API_URL, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(payload)
    });
    
    if (!response.ok) {
      const error = await response.text();
      this.logger.error(`Z.ai API error: ${response.status} ${error}`);
      throw new Error(`Z.ai API error: ${response.status}`);
    }
    
    const data = await response.json();
    return data.choices[0].message.content;
  }
  
  async chatStream(prompt, systemPrompt = null, callback) {
    // Потоковая обработка для больших ответов
    // ...
  }
  
  getDefaultSystemPrompt() {
    return `You are an Elite Staff Engineer and meticulous Code Reviewer. 
Your objective is to thoroughly analyze Pull Request diffs, identify potential 
bugs, security vulnerabilities, and architectural flaws, and provide 
constructive, actionable feedback.`;
  }
  
  async analyzeCode(diff, context = {}) {
    const prompt = this.buildCodeAnalysisPrompt(diff, context);
    return this.chat(prompt);
  }
  
  buildCodeAnalysisPrompt(diff, context) {
    return `Please analyze the following code changes:

<diff>
${diff}
</diff>

${context.language ? `Language: ${context.language}` : ''}
${context.filename ? `File: ${context.filename}` : ''}

Provide a detailed analysis including:
1. Potential bugs
2. Security vulnerabilities
3. Performance issues
4. Code quality improvements`;
  }
}
```

### 5. Авто-ревью PR

**Файл:** `src/lib/auto-review.js`

```javascript
import { ZaiApiClient } from './api.js';
import { createLogger } from './logging.js';

export class AutoReview {
  constructor(apiKey, model) {
    this.zai = new ZaiApiClient(apiKey, model);
    this.logger = createLogger({ context: 'AutoReview' });
  }
  
  async analyzePullRequest(files, pullRequest) {
    const logger = this.logger;
    
    // Фильтруем файлы с изменениями
    const changedFiles = files.filter(f => f.patch);
    
    if (changedFiles.length === 0) {
      return { comments: [] };
    }
    
    // Проверяем, большой ли PR
    const isLargePr = this.isLargePr(changedFiles);
    
    if (isLargePr) {
      logger.info('Large PR detected, using batched processing');
      return this.processLargePr(changedFiles, pullRequest);
    }
    
    // Обрабатываем как обычный PR
    return this.processRegularPr(changedFiles, pullRequest);
  }
  
  isLargePr(files) {
    const totalChars = files.reduce((sum, f) => sum + (f.patch?.length || 0), 0);
    const fileCount = files.length;
    
    return fileCount > 50 || totalChars > 120000;
  }
  
  async processRegularPr(files, pullRequest) {
    const prompt = this.buildReviewPrompt(files, pullRequest);
    
    const review = await this.zai.chat(prompt, this.getReviewSystemPrompt());
    
    // Парсим ответ и создаём комментарии
    const comments = this.parseReviewResponse(review, files);
    
    return { comments };
  }
  
  async processLargePr(files, pullRequest) {
    // Разбиваем на батчи
    const batches = this.createBatches(files);
    const allComments = [];
    
    for (const batch of batches) {
      const batchPrompt = this.buildBatchReviewPrompt(batch, pullRequest);
      const batchReview = await this.zai.chat(batchPrompt, this.getReviewSystemPrompt());
      const batchComments = this.parseReviewResponse(batchReview, batch);
      allComments.push(...batchComments);
    }
    
    // Синтезируем общий отчёт
    const synthesis = await this.synthesizeReviews(allComments, pullRequest);
    
    return { comments: allComments, synthesis };
  }
  
  createBatches(files) {
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
  
  buildReviewPrompt(files, pullRequest) {
    const fileContents = files
      .map(f => `<file name="${f.filename}">\n<diff>\n${f.patch}\n</diff>\n</file>`)
      .join('\n\n');
    
    return `Please review the following Pull Request changes:

<pull_request>
Title: ${pullRequest.title}
Description: ${pullRequest.body || 'No description'}
Author: ${pullRequest.user.login}
</pull_request>

<changes>
${fileContents}
</changes>

Provide a detailed code review focusing on:
1. Bugs and logical errors
2. Security vulnerabilities
3. Performance issues
4. Code quality and best practices
5. Architecture and design issues

Format your response as JSON with the following structure:
{
  "summary": "Overall assessment",
  "comments": [
    {
      "file": "filename",
      "line": 123,
      "type": "bug|security|performance|quality|architecture",
      "severity": "critical|high|medium|low",
      "message": "Detailed comment"
    }
  ]
}`;
  }
  
  getReviewSystemPrompt() {
    return `You are an expert code reviewer. Analyze the provided code changes and 
identify issues. Always respond in JSON format as specified in the prompt.`;
  }
  
  parseReviewResponse(response, files) {
    // Парсим JSON ответ от Z.ai
    try {
      const parsed = JSON.parse(response);
      return parsed.comments || [];
    } catch (e) {
      // Если не JSON, пытаемся парсить как текст
      return this.parseTextResponse(response, files);
    }
  }
  
  async synthesizeReviews(comments, pullRequest) {
    const synthesisPrompt = `Synthesize the following code review comments into a summary:

${JSON.stringify(comments, null, 2)}

Pull Request: ${pullRequest.title}

Provide a concise summary of the main issues found.`;
    
    return await this.zai.chat(synthesisPrompt);
  }
}
```

### 6. Обработчики команд

**Файл:** `src/lib/handlers/index.js`

```javascript
import { handleAskCommand } from './ask.js';
import { handleReviewCommand } from './review.js';
import { handleExplainCommand } from './explain.js';
import { handleDescribeCommand } from './describe.js';
import { handleImpactCommand } from './impact.js';
import { handleHelpCommand } from './help.js';

export const handlers = {
  ask: {
    execute: handleAskCommand,
    requiresRepo: true,
    description: 'Ask a question about the code'
  },
  review: {
    execute: handleReviewCommand,
    requiresRepo: true,
    description: 'Request a full code review'
  },
  explain: {
    execute: handleExplainCommand,
    requiresRepo: true,
    description: 'Explain specific lines of code'
  },
  describe: {
    execute: handleDescribeCommand,
    requiresRepo: true,
    description: 'Generate PR description from commits'
  },
  impact: {
    execute: handleImpactCommand,
    requiresRepo: true,
    description: 'Analyze the potential impact of changes'
  },
  help: {
    execute: handleHelpCommand,
    requiresRepo: false,
    description: 'Show help message'
  }
};
```

### 7. Конфигурация Cloudflare

**Файл:** `wrangler.toml`

```toml
name = "zai-code-bot"
main = "src/index.js"
compatibility_date = "2024-01-01"

# Конфигурация Computer
[computer]
# Разрешаем использование Computer API
enabled = true

# Конфигурация KV для хранения состояния
[[kv_namespaces]]
binding = "STATE"
id = "your-kv-namespace-id"

# Конфигурация KV для кэширования
[[kv_namespaces]]
binding = "CACHE"
id = "your-cache-namespace-id"

# Конфигурация Durable Objects для сессий
[[durable_objects]]
name = "Session"
class_name = "Session"

# Конфигурация Cron для запланированных задач
[triggers]
crons = [
  "0 6 * * 1",  # Каждый понедельник в 6:00 UTC
  "0 0 * * 1"   # Каждый понедельник в 0:00 UTC
]

# Переменные окружения (для разработки)
[vars]
ZAI_MODEL = "glm-5.2"
NODE_ENV = "production"

# Секреты (настраиваются через Cloudflare Dashboard)
# ZAI_API_KEY
# GITHUB_WEBHOOK_SECRET
# GITHUB_TOKEN
```

### 8. Package.json

```json
{
  "name": "zai-code-bot-cloudflare",
  "version": "1.0.0",
  "description": "Z.ai Code Bot powered by Cloudflare Computer",
  "main": "src/index.js",
  "scripts": {
    "dev": "wrangler dev",
    "deploy": "wrangler deploy",
    "tail": "wrangler tail",
    "test": "vitest run",
    "test:watch": "vitest watch"
  },
  "dependencies": {
    "@cloudflare/computer": "^1.0.0",
    "@cloudflare/workers": "^4.0.0"
  },
  "devDependencies": {
    "vitest": "^3.0.0",
    "wrangler": "^3.0.0"
  }
}
```

## 🔧 Конфигурация изолятов

### Для разных типов задач

```javascript
// Конфигурации изолятов
export const ISOLATE_CONFIGS = {
  // Обработка команд
  command: {
    memory: '256MB',
    cpu: '50ms',
    timeout: '60s',
    filesystem: {
      '/repo': { size: '1GB' },
      '/tmp': { size: '256MB' }
    }
  },
  
  // Авто-ревью PR
  review: {
    memory: '512MB',
    cpu: '100ms',
    timeout: '120s',
    filesystem: {
      '/repo': { size: '2GB' },
      '/tmp': { size: '512MB' }
    }
  },
  
  // Анализ кода
  analysis: {
    memory: '1GB',
    cpu: '200ms',
    timeout: '180s',
    filesystem: {
      '/repo': { size: '4GB' },
      '/tmp': { size: '1GB' }
    }
  },
  
  // Запланированные задачи
  scheduled: {
    memory: '256MB',
    cpu: '50ms',
    timeout: '300s',
    filesystem: {
      '/repo': { size: '1GB' },
      '/tmp': { size: '256MB' }
    }
  }
};

// Конфигурации контейнеров
export const CONTAINER_CONFIGS = {
  // Запуск тестов
  test: {
    memory: '4GB',
    cpu: '500ms',
    timeout: '10m',
    filesystem: {
      '/repo': { size: '10GB' },
      '/node_modules': { size: '5GB' }
    },
    // Используем Node.js образ
    image: 'node:20-alpine'
  },
  
  // Сборка проекта
  build: {
    memory: '8GB',
    cpu: '1000ms',
    timeout: '15m',
    filesystem: {
      '/repo': { size: '10GB' },
      '/node_modules': { size: '5GB' },
      '/dist': { size: '2GB' }
    },
    image: 'node:20-alpine'
  }
};
```

## 📊 Мониторинг и логирование

**Файл:** `src/lib/logging.js`

```javascript
export class Logger {
  constructor(env) {
    this.env = env;
    this.context = env.LOGGER_CONTEXT || 'zai-code-bot';
  }
  
  log(level, message, data = {}) {
    const timestamp = new Date().toISOString();
    const logEntry = {
      timestamp,
      level,
      context: this.context,
      message,
      ...data
    };
    
    // Логируем в Cloudflare Logs
    console.log(JSON.stringify(logEntry));
    
    // Сохраняем в KV для долговременного хранения
    if (this.env.LOG_STORAGE) {
      this.storeLog(logEntry);
    }
    
    // Отправляем метрики
    if (this.env.METRICS) {
      this.sendMetrics(level, message, data);
    }
  }
  
  info(message, data = {}) {
    this.log('INFO', message, data);
  }
  
  warn(message, data = {}) {
    this.log('WARN', message, data);
  }
  
  error(message, data = {}) {
    this.log('ERROR', message, data);
  }
  
  debug(message, data = {}) {
    if (this.env.NODE_ENV === 'development') {
      this.log('DEBUG', message, data);
    }
  }
  
  async storeLog(logEntry) {
    try {
      const logKey = `logs:${Date.now()}:${Math.random().toString(36).substr(2, 9)}`;
      await this.env.LOG_STORAGE.put(logKey, JSON.stringify(logEntry));
    } catch (e) {
      console.error('Failed to store log:', e);
    }
  }
  
  async sendMetrics(level, message, data) {
    // Отправляем метрики в Cloudflare Analytics
    // или внешние системы мониторинга
    // ...
  }
}

export function createLogger(env) {
  return new Logger(env);
}

export function generateCorrelationId() {
  return `zai-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
}
```

## 🔐 Безопасность

### 1. Авторизация

**Файл:** `src/lib/auth.js`

```javascript
import { createLogger } from './logging.js';

export class Auth {
  constructor(env) {
    this.env = env;
    this.logger = createLogger(env);
  }
  
  async verifyGitHubSignature(request, secret) {
    const signature = request.headers.get('x-hub-signature-256');
    const payload = await request.text();
    
    const hmac = crypto.createHmac('sha256', secret);
    hmac.update(payload);
    const expectedSignature = `sha256=${hmac.digest('hex')}`;
    
    return crypto.timingSafeEqual(
      Buffer.from(signature),
      Buffer.from(expectedSignature)
    );
  }
  
  async checkForkAuthorization(octokit, owner, repo, user) {
    // Проверяем, имеет ли пользователь право работать с форком
    // ...
  }
  
  async getUnauthorizedMessage(user, repo) {
    return `## ⚠️ Authorization Required

@${user}, you don't have permission to run /zai commands on this repository.

Please ensure you have:
1. Write access to this repository
2. Proper permissions configured

If you believe this is an error, please contact the repository maintainer.`;
  }
  
  async getCommenter(octokit, context) {
    // Получаем информацию о комментаторе
    // ...
  }
}
```

### 2. Rate Limiting

**Файл:** `src/lib/rate-limit.js`

```javascript
export class RateLimiter {
  constructor(env) {
    this.env = env;
    this.limits = {
      // Лимиты для разных типов операций
      apiCalls: {
        max: 100,
        window: 60 * 1000  // 1 минута
      },
      reviews: {
        max: 10,
        window: 60 * 1000
      },
      comments: {
        max: 50,
        window: 60 * 1000
      }
    };
  }
  
  async checkLimit(userId, operation) {
    const limit = this.limits[operation];
    if (!limit) return true;
    
    const key = `rate_limit:${userId}:${operation}`;
    const now = Date.now();
    
    // Получаем текущие данные из KV
    const data = await this.env.KV.get(key, { type: 'json' });
    
    if (!data) {
      // Первая операция в этом окне
      await this.env.KV.put(key, JSON.stringify({
        count: 1,
        windowStart: now
      }), { expirationTtl: Math.ceil(limit.window / 1000) });
      
      return true;
    }
    
    // Проверяем, истёк ли window
    if (now - data.windowStart > limit.window) {
      await this.env.KV.put(key, JSON.stringify({
        count: 1,
        windowStart: now
      }), { expirationTtl: Math.ceil(limit.window / 1000) });
      
      return true;
    }
    
    // Проверяем лимит
    if (data.count >= limit.max) {
      return false;
    }
    
    // Увеличиваем счётчик
    await this.env.KV.put(key, JSON.stringify({
      count: data.count + 1,
      windowStart: data.windowStart
    }), { expirationTtl: Math.ceil(limit.window / 1000) });
    
    return true;
  }
  
  async getRemaining(userId, operation) {
    const limit = this.limits[operation];
    if (!limit) return Infinity;
    
    const key = `rate_limit:${userId}:${operation}`;
    const data = await this.env.KV.get(key, { type: 'json' });
    
    if (!data) return limit.max;
    
    const now = Date.now();
    
    if (now - data.windowStart > limit.window) {
      return limit.max;
    }
    
    return limit.max - data.count;
  }
}
```

## 🚀 Деплой и CI/CD

### 1. Локальная разработка

```bash
# Установка зависимостей
npm install

# Запуск локального сервера
npm run dev

# Тестирование
npm test
```

### 2. Деплой на Cloudflare

```bash
# Логин в Cloudflare
wrangler login

# Деплой
npm run deploy

# Просмотр логов
npm run tail
```

### 3. CI/CD Pipeline

**Файл:** `.github/workflows/deploy.yml`

```yaml
name: Deploy to Cloudflare

on:
  push:
    branches: [main, cloudflare-migration]
  pull_request:
    branches: [main]

jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: '20'
      - run: npm ci
      - run: npm test

  deploy:
    needs: test
    runs-on: ubuntu-latest
    if: github.ref == 'refs/heads/main' || github.ref == 'refs/heads/cloudflare-migration'
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: '20'
      - run: npm ci
      - run: npm run deploy
        env:
          CLOUDFLARE_API_TOKEN: ${{ secrets.CLOUDFLARE_API_TOKEN }}
          CLOUDFLARE_ACCOUNT_ID: ${{ secrets.CLOUDFLARE_ACCOUNT_ID }}
```

## 📈 Мониторинг

### Cloudflare Analytics
- Метрики запросов
- Время отклика
- Ошибки
- Использование ресурсов

### Кастомные метрики
- Количество обработанных PR
- Количество команд
- Время обработки
- Успешность операций

### Алерты
- Ошибки аутентификации
- Превышение лимитов
- Длительное время обработки
- Падение производительности

---

**Статус:** Архитектура готова для реализации
**Следующий шаг:** Начать реализацию базового функционала
