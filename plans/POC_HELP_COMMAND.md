# 🎯 Proof-of-Concept: Перенос команды `/zai help` на Cloudflare Computer

## 📋 Обзор проекта

**Цель:** Создать минимально работающий прототип обработки команды `/zai help` на Cloudflare Computer для валидации архитектуры и измерения производительности.

**Сcope:** Только команда `/zai help` (самая простая команда, не требующая анализа кода)

**Ожидаемые результаты:**
- ✅ Работающий Cloudflare Worker
- ✅ Обработка GitHub webhook с командой `/zai help`
- ✅ Ответ в GitHub issue/PR комментарии
- ✅ Измеренная производительность (время отклика, стоимость)
- ✅ Документация по настройке и деплою

---

## 🏗️ Архитектура POC

```
┌─────────────────────────────────────────────────────────────────┐
│                        GitHub Repository                            │
│                                                                      │
│  ┌─────────────┐    ┌─────────────┐    ┌─────────────────────┐   │
│  │  User       │    │  PR/Issue   │    │  Comment:            │   │
│  │  (author)   │───▶│  (open)     │───▶│  "/zai help"        │   │
│  └─────────────┘    └─────────────┘    └─────────────────────┘   │
│                                                                      │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                     Cloudflare Worker                              │
│                                                                      │
│  ┌─────────────────┐    ┌─────────────────┐    ┌───────────────┐ │
│  │  GitHub         │───▶│  Event Router   │───▶│  Isolate      │ │
│  │  Webhook        │    │  (index.js)     │    │  (Handler)    │ │
│  └─────────────────┘    └─────────────────┘    └───────────────┘ │
│                                                                      │
│  ┌─────────────────┐    ┌─────────────────┐                      │
│  │  GitHub API      │◀───│  GitHub Client   │                      │
│  │  (Comments)      │    │  (github.js)     │                      │
│  └─────────────────┘    └─────────────────┘                      │
│                                                                      │
└─────────────────────────────────────────────────────────────────┘
```

---

## 📅 Детальный план реализации

### Фаза 0: Подготовка окружения (1 день)

#### 0.1 Создание Cloudflare аккаунта и проекта
- [ ] **Зарегистрироваться** в Cloudflare (если ещё не сделано)
- [ ] **Создать новый Workers проект**
  - Название: `zai-code-bot-poc`
  - Тип: `Workers & Pages`
- [ ] **Установить Wrangler CLI**
  ```bash
  npm install -g wrangler
  wrangler login
  ```

#### 0.2 Настройка GitHub
- [ ] **Создать Personal Access Token**
  - Scope: `repo`, `read:org`
  - Название: `zai-code-bot-poc`
  - Сохранить в Cloudflare Secrets как `GITHUB_TOKEN`
- [ ] **Настроить Webhook** в тестовом репозитории
  - URL: `https://zai-code-bot-poc.<account>.workers.dev`
  - Content type: `application/json`
  - Secret: сгенерировать и сохранить в Cloudflare Secrets как `GITHUB_WEBHOOK_SECRET`
  - Events: `Issue comments`, `Pull request reviews`

#### 0.3 Настройка Cloudflare
- [ ] **Создать KV namespace** для состояния
  ```bash
  wrangler kv:namespace create "STATE"
  ```
- [ ] **Создать KV namespace** для кэша
  ```bash
  wrangler kv:namespace create "CACHE"
  ```
- [ ] **Сохранить ID namespace** в `wrangler.toml`

---

### Фаза 1: Базовая инфраструктура (2 дня)

#### 1.1 Создание структуры проекта
```
zai-code-bot-cloudflare/
├── src/
│   ├── index.js              # Основной Worker (Entry Point)
│   ├── lib/
│   │   ├── github.js         # GitHub API клиент
│   │   ├── commands.js       # Парсинг команд
│   │   ├── handlers/
│   │   │   └── help.js       # Обработчик /zai help
│   │   └── logging.js        # Логирование
│   └── config/
│       └── constants.js      # Константы
├── wrangler.toml             # Конфигурация Cloudflare
├── package.json
└── .env                      # Локальные переменные
```

#### 1.2 Настройка package.json
```json
{
  "name": "zai-code-bot-poc",
  "version": "0.1.0",
  "description": "Proof-of-Concept: Z.ai Code Bot on Cloudflare Computer",
  "main": "src/index.js",
  "scripts": {
    "dev": "wrangler dev",
    "deploy": "wrangler deploy",
    "tail": "wrangler tail",
    "test": "node tests/test.js"
  },
  "dependencies": {
    "@cloudflare/computer": "^1.0.0",
    "@cloudflare/workers": "^4.0.0"
  },
  "devDependencies": {
    "wrangler": "^3.0.0"
  }
}
```

#### 1.3 Настройка wrangler.toml
```toml
name = "zai-code-bot-poc"
main = "src/index.js"
compatibility_date = "2024-01-01"

# Включаем Computer API
[computer]
enabled = true

# KV для состояния
[[kv_namespaces]]
binding = "STATE"
id = "your-state-namespace-id"

# KV для кэша
[[kv_namespaces]]
binding = "CACHE"
id = "your-cache-namespace-id"

# Переменные окружения (для разработки)
[vars]
NODE_ENV = "development"
ZAI_MODEL = "glm-5.2"

# Секреты настраиваются через:
# wrangler secret put ZAI_API_KEY
# wrangler secret put GITHUB_TOKEN
# wrangler secret put GITHUB_WEBHOOK_SECRET
```

---

### Фаза 2: Реализация ядра (3 дня)

#### 2.1 Реализация GitHub API клиента

**Файл:** `src/lib/github.js`

```javascript
/**
 * GitHub API Client для Cloudflare Workers
 * Осуществляет взаимодействие с GitHub API
 */

export class GitHubClient {
  /**
   * @param {string} token - GitHub Personal Access Token
   */
  constructor(token) {
    this.token = token;
    this.baseUrl = 'https://api.github.com';
  }
  
  /**
   * Универсальный метод для запросов к GitHub API
   * @param {string} method - HTTP метод (GET, POST, PUT, DELETE)
   * @param {string} path - Путь API (например, /repos/owner/repo/issues)
   * @param {Object} [data] - Данные для POST/PUT
   * @returns {Promise<Object>} - Ответ от GitHub API
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
   * Проверяет подпись GitHub webhook
   * @param {Request} request - Cloudflare Request объект
   * @param {string} secret - Webhook secret
   * @returns {Promise<boolean>} - Валидна ли подпись
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
   * Получает информацию о репозитории
   * @param {string} owner - Владелец репозитория
   * @param {string} repo - Имя репозитория
   * @returns {Promise<Object>} - Информация о репозитории
   */
  async getRepository(owner, repo) {
    return this.request('GET', `/repos/${owner}/${repo}`);
  }
  
  /**
   * Публикует комментарий к issue или PR
   * @param {string} owner - Владелец репозитория
   * @param {string} repo - Имя репозитория
   * @param {number} issueNumber - Номер issue или PR
   * @param {string} body - Текст комментария
   * @returns {Promise<Object>} - Созданный комментарий
   */
  async postComment(owner, repo, issueNumber, body) {
    return this.request(
      'POST',
      `/repos/${owner}/${repo}/issues/${issueNumber}/comments`,
      { body }
    );
  }
  
  /**
   * Получает информацию о пользователе
   * @param {string} username - Имя пользователя
   * @returns {Promise<Object>} - Информация о пользователе
   */
  async getUser(username) {
    return this.request('GET', `/users/${username}`);
  }
  
  /**
   * Проверяет, имеет ли пользователь доступ к репозиторию
   * @param {string} owner - Владелец репозитория
   * @param {string} repo - Имя репозитория
   * @param {string} username - Имя пользователя
   * @returns {Promise<boolean>} - Есть ли доступ
   */
  async checkRepositoryAccess(owner, repo, username) {
    try {
      // Проверяем, является ли пользователь коллаборатором
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
}
```

#### 2.2 Реализация парсинга команд

**Файл:** `src/lib/commands.js`

```javascript
/**
 * Парсинг команд /zai из комментариев
 */

// Регулярное выражение для парсинга команд
const COMMAND_REGEX = /^\/(zai|zai-bot)\s+([a-zA-Z0-9_-]+)(?:\s+(.*))?$/;
const MENTION_REGEX = /^@zai-bot\s+([a-zA-Z0-9_-]+)(?:\s+(.*))?$/;

// Список доступных команд
const AVAILABLE_COMMANDS = ['help', 'ask', 'review', 'explain', 'describe', 'impact'];

/**
 * Парсит команду из текста комментария
 * @param {string} text - Текст комментария
 * @returns {Object|null} - Объект команды или null
 */
export function parseCommand(text) {
  if (!text || typeof text !== 'string') {
    return null;
  }
  
  const trimmed = text.trim();
  
  // Пробуем парсинг через /zai
  let match = trimmed.match(COMMAND_REGEX);
  if (match) {
    return {
      type: match[2].toLowerCase(),
      args: match[3] || '',
      raw: trimmed,
      isValid: AVAILABLE_COMMANDS.includes(match[2].toLowerCase())
    };
  }
  
  // Пробуем парсинг через @zai-bot
  match = trimmed.match(MENTION_REGEX);
  if (match) {
    return {
      type: match[1].toLowerCase(),
      args: match[2] || '',
      raw: trimmed,
      isValid: AVAILABLE_COMMANDS.includes(match[1].toLowerCase())
    };
  }
  
  return null;
}

/**
 * Проверяет, является ли текст комментария командой
 * @param {string} text - Текст комментария
 * @returns {boolean} - Является ли командой
 */
export function isCommand(text) {
  return parseCommand(text) !== null;
}

/**
 * Получает список всех доступных команд
 * @returns {string[]} - Список команд
 */
export function getAvailableCommands() {
  return AVAILABLE_COMMANDS;
}

/**
 * Форматирует помощь по командам
 * @returns {string} - Текст помощи
 */
export function formatHelp() {
  return `## 🤖 Z.ai Code Bot Help

Available commands:

### Code Review & Analysis
- \`/zai review\` - Request a full code review of the PR
- \`/zai explain <lines>\` - Explain specific lines of code (e.g., \`/zai explain 10-20\`)
- \`/zai ask <question>\` - Ask a question about the code
- \`/zai impact\` - Analyze the potential impact of changes

### Documentation
- \`/zai describe\` - Generate PR description from commits

### Help
- \`/zai help\` - Show this help message

### Usage Notes
- Commands can be triggered with \`/zai\` or @zai-bot
- Example: \`/zai review\` or @zai-bot review
- For line-specific commands, specify line numbers or ranges

---
*Powered by [Z.ai](https://z.ai) and [Cloudflare Computer](https://cloudflare.com)*

<!-- zai-code-review -->`;
}
```

#### 2.3 Реализация обработчика команды help

**Файл:** `src/lib/handlers/help.js`

```javascript
/**
 * Обработчик команды /zai help
 * Самая простая команда для POC
 */

import { formatHelp } from '../commands.js';
import { COMMENT_MARKER } from '../config/constants.js';

/**
 * Обрабатывает команду help
 * @param {Object} context - Контекст выполнения
 * @param {Object} context.github - GitHub API клиент
 * @param {Object} context.event - Информация о событии
 * @returns {Promise<Object>} - Результат выполнения
 */
export async function handleHelpCommand(context) {
  const { github, event } = context;
  
  try {
    // Формируем ответ
    const response = formatHelp();
    
    // Публикуем комментарий
    await github.postComment(
      event.repository.owner.login,
      event.repository.name,
      event.issue.number,
      response
    );
    
    return {
      status: 'success',
      action: 'help',
      response: 'Help message posted successfully'
    };
  } catch (error) {
    console.error('Error handling help command:', error);
    
    // Публикуем ошибку
    await github.postComment(
      event.repository.owner.login,
      event.repository.name,
      event.issue.number,
      `## ❌ Error

Failed to process /zai help command:

\`\`\`
${error.message}
\`\`\`

${COMMENT_MARKER}`
    );
    
    return {
      status: 'error',
      action: 'help',
      error: error.message
    };
  }
}

/**
 * Проверяет, подходит ли этот обработчик для команды
 * @param {string} commandType - Тип команды
 * @returns {boolean} - Подходит ли обработчик
 */
export function canHandle(commandType) {
  return commandType === 'help';
}

/**
 * Metadata обработчика
 */
export const handlerMetadata = {
  name: 'help',
  description: 'Show help message with available commands',
  requiresRepo: false,  // Не нужно клонировать репозиторий
  requiresCodeAccess: false,  // Не нужно читать код
  rateLimit: {
    max: 10,
    window: 60000  // 10 запросов в минуту
  }
};
```

#### 2.4 Реализация основного Worker

**Файл:** `src/index.js`

```javascript
/**
 * Z.ai Code Bot - Proof-of-Concept
 * Основной Cloudflare Worker для обработки GitHub событий
 */

import { Computer } from '@cloudflare/computer';
import { GitHubClient } from './lib/github.js';
import { parseCommand, isCommand } from './lib/commands.js';
import { handleHelpCommand, canHandle as canHandleHelp } from './lib/handlers/help.js';
import { createLogger } from './lib/logging.js';

// Константы
const GITHUB_WEBHOOK_SECRET = 'GITHUB_WEBHOOK_SECRET';
const GITHUB_TOKEN = 'GITHUB_TOKEN';
const COMMENT_MARKER = '<!-- zai-code-review -->';

// Конфигурация изолятов
const ISOLATE_CONFIGS = {
  command: {
    memory: '128MB',
    cpu: '10ms',
    timeout: '30s',
    filesystem: { '/tmp': { size: '64MB' } }
  }
};

/**
 * Создаёт логгер
 * @param {Object} env - Переменные окружения
 * @returns {Object} - Логгер
 */
function createAppLogger(env) {
  return {
    info: (message, data = {}) => {
      console.log(JSON.stringify({ timestamp: new Date().toISOString(), level: 'INFO', message, ...data }));
    },
    warn: (message, data = {}) => {
      console.log(JSON.stringify({ timestamp: new Date().toISOString(), level: 'WARN', message, ...data }));
    },
    error: (message, data = {}) => {
      console.log(JSON.stringify({ timestamp: new Date().toISOString(), level: 'ERROR', message, ...data }));
    }
  };
}

/**
 * Парсит GitHub webhook payload
 * @param {Request} request - Cloudflare Request
 * @returns {Object} - Парсированные данные
 */
async function parseGitHubWebhook(request) {
  const payload = await request.json();
  const headers = request.headers;
  
  return {
    event: headers.get('x-github-event'),
    action: payload.action,
    repository: payload.repository,
    pull_request: payload.pull_request,
    issue: payload.issue,
    comment: payload.comment,
    sender: payload.sender,
    installation: payload.installation
  };
}

/**
 * Определяет тип события
 * @param {Object} webhookData - Данные webhook
 * @returns {string} - Тип события
 */
function getEventType(webhookData) {
  const { event, pull_request, issue, comment } = webhookData;
  
  if (event === 'pull_request') {
    return `pull_request_${webhookData.action}`;
  }
  
  if (event === 'issue_comment') {
    if (issue && issue.pull_request) {
      return 'pull_request_comment';
    }
    return 'issue_comment';
  }
  
  if (event === 'pull_request_review_comment') {
    return 'pull_request_review_comment';
  }
  
  return event;
}

/**
 * Проверяет, нужно ли обрабатывать событие
 * @param {Object} webhookData - Данные webhook
 * @returns {boolean} - Нужно ли обрабатывать
 */
function shouldProcessEvent(webhookData) {
  const { event, comment } = webhookData;
  
  // Обрабатываем комментарии с командами
  if (event === 'issue_comment' || event === 'pull_request_comment') {
    return isCommand(comment?.body);
  }
  
  // Обрабатываем PR review комментарии
  if (event === 'pull_request_review_comment') {
    return isCommand(comment?.body);
  }
  
  return false;
}

/**
 * Обрабатывает комментарий с командой
 * @param {Object} env - Переменные окружения
 * @param {Object} webhookData - Данные webhook
 * @returns {Promise<Response>} - Ответ
 */
async function handleCommentCommand(env, webhookData) {
  const logger = createAppLogger(env);
  const { repository, issue, comment } = webhookData;
  
  logger.info('Processing comment command', {
    repo: repository?.full_name,
    issue: issue?.number,
    user: comment?.user?.login
  });
  
  // Парсим команду
  const command = parseCommand(comment.body);
  
  if (!command || !command.isValid) {
    logger.warn('Invalid or unknown command', { raw: comment.body });
    return new Response('Not a valid zai command', { status: 200 });
  }
  
  // Создаём GitHub клиент
  const github = new GitHubClient(env[GITHUB_TOKEN]);
  
  // Проверяем авторизацию
  const hasAccess = await github.checkRepositoryAccess(
    repository.owner.login,
    repository.name,
    comment.user.login
  );
  
  if (!hasAccess) {
    logger.warn('Unauthorized access attempt', {
      user: comment.user.login,
      repo: repository.full_name
    });
    
    await github.postComment(
      repository.owner.login,
      repository.name,
      issue.number,
      `## ⚠️ Authorization Required

@${comment.user.login}, you don't have permission to run /zai commands on this repository.

Please ensure you have write access to this repository.

${COMMENT_MARKER}`
    );
    
    return new Response('Unauthorized', { status: 403 });
  }
  
  // Маршрутизация команд
  switch (command.type) {
    case 'help':
      return handleHelpCommand({
        github,
        event: {
          repository,
          issue,
          comment,
          command
        }
      });
    
    default:
      logger.warn('Unsupported command for POC', { command: command.type });
      await github.postComment(
        repository.owner.login,
        repository.name,
        issue.number,
        `## ⚠️ Command Not Available in POC

The command \`/zai ${command.type}\` is not available in this proof-of-concept version.

Currently supported: \`/zai help\`

${COMMENT_MARKER}`
      );
      return new Response('Command not available in POC', { status: 200 });
  }
}

/**
 * Основной обработчик Cloudflare Worker
 */
export default {
  async fetch(request, env, ctx) {
    const logger = createAppLogger(env);
    
    try {
      // Проверяем, что это POST запрос
      if (request.method !== 'POST') {
        return new Response('Method Not Allowed', { status: 405 });
      }
      
      // Проверяем Content-Type
      const contentType = request.headers.get('content-type');
      if (contentType !== 'application/json') {
        return new Response('Unsupported Media Type', { status: 415 });
      }
      
      // Проверяем подпись GitHub webhook
      const isValid = await GitHubClient.verifyWebhookSignature(
        request,
        env[GITHUB_WEBHOOK_SECRET]
      );
      
      if (!isValid) {
        logger.warn('Invalid GitHub webhook signature');
        return new Response('Unauthorized', { status: 401 });
      }
      
      // Парсим webhook
      const webhookData = await parseGitHubWebhook(request);
      
      logger.info('Received webhook', {
        event: webhookData.event,
        action: webhookData.action,
        repo: webhookData.repository?.full_name
      });
      
      // Проверяем, нужно ли обрабатывать
      if (!shouldProcessEvent(webhookData)) {
        logger.info('Skipping event', { event: webhookData.event });
        return new Response('OK', { status: 200 });
      }
      
      // Обрабатываем комментарий с командой
      const result = await handleCommentCommand(env, webhookData);
      
      logger.info('Command processed', {
        status: result?.status || 'unknown',
        action: result?.action
      });
      
      return new Response(JSON.stringify(result || {}), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      });
      
    } catch (error) {
      logger.error('Error processing request:', error);
      return new Response('Internal Server Error', { status: 500 });
    }
  }
};
```

#### 2.5 Реализация конфигурации и констант

**Файл:** `src/config/constants.js`

```javascript
/**
 * Константы приложения
 */

// Маркеры для комментариев
export const COMMENT_MARKER = '<!-- zai-code-review -->';
export const PROGRESS_MARKER = '<!-- zai-progress -->';

// Названия команд
export const COMMANDS = {
  HELP: 'help',
  ASK: 'ask',
  REVIEW: 'review',
  EXPLAIN: 'explain',
  DESCRIBE: 'describe',
  IMPACT: 'impact'
};

// Типы событий
export const EVENT_TYPES = {
  PULL_REQUEST_OPENED: 'pull_request_opened',
  PULL_REQUEST_SYNC: 'pull_request_synchronize',
  ISSUE_COMMENT: 'issue_comment',
  PR_COMMENT: 'pull_request_comment',
  PR_REVIEW_COMMENT: 'pull_request_review_comment'
};

// Конфигурация по умолчанию
export const DEFAULT_CONFIG = {
  zaiModel: 'glm-5.2',
  timeout: 30000,  // 30 секунд
  maxRetries: 3
};

// Сообщения об ошибках
export const ERROR_MESSAGES = {
  UNAUTHORIZED: 'You do not have permission to run this command.',
  UNKNOWN_COMMAND: 'Unknown command. Use /zai help to see available commands.',
  INTERNAL_ERROR: 'An internal error occurred. Please try again later.'
};
```

**Файл:** `src/lib/logging.js`

```javascript
/**
 * Логирование для Cloudflare Workers
 */

/**
 * Создаёт логгер
 * @param {Object} env - Переменные окружения
 * @param {string} context - Контекст логгирования
 * @returns {Object} - Логгер
 */
export function createLogger(env, context = 'default') {
  const envName = env.NODE_ENV || 'production';
  
  return {
    log: (level, message, data = {}) => {
      const timestamp = new Date().toISOString();
      const logEntry = {
        timestamp,
        level,
        context,
        env: envName,
        message,
        ...data
      };
      
      // Логируем в Cloudflare Logs
      console.log(JSON.stringify(logEntry));
    },
    
    info: (message, data = {}) => {
      this.log('INFO', message, data);
    },
    
    warn: (message, data = {}) => {
      this.log('WARN', message, data);
    },
    
    error: (message, data = {}) => {
      this.log('ERROR', message, data);
    },
    
    debug: (message, data = {}) => {
      if (envName === 'development') {
        this.log('DEBUG', message, data);
      }
    }
  };
}

/**
 * Генерирует уникальный ID корреляции
 * @returns {string} - ID корреляции
 */
export function generateCorrelationId() {
  return `zai-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
}
```

---

### Фаза 3: Тестирование (2 дня)

#### 3.1 Локальное тестирование

**Создать тестовый скрипт:** `tests/test.js`

```javascript
/**
 * Тесты для POC
 */

import { parseCommand, isCommand, getAvailableCommands, formatHelp } from '../src/lib/commands.js';
import { GitHubClient } from '../src/lib/github.js';

// Тест парсинга команд
function testCommandParsing() {
  console.log('Testing command parsing...');
  
  const testCases = [
    { input: '/zai help', expected: { type: 'help', isValid: true } },
    { input: '/zai-bot help', expected: { type: 'help', isValid: true } },
    { input: '@zai-bot help', expected: { type: 'help', isValid: true } },
    { input: '/zai review', expected: { type: 'review', isValid: true } },
    { input: '/zai unknown', expected: { type: 'unknown', isValid: false } },
    { input: 'random text', expected: null },
    { input: '', expected: null }
  ];
  
  for (const testCase of testCases) {
    const result = parseCommand(testCase.input);
    const passed = result?.type === testCase.expected?.type && 
                  result?.isValid === testCase.expected?.isValid;
    
    console.log(`  ${passed ? '✅' : '❌'} ${testCase.input} -> ${JSON.stringify(result)}`);
  }
}

// Тест форматирования помощи
function testHelpFormatting() {
  console.log('\nTesting help formatting...');
  const help = formatHelp();
  console.log('  Help message length:', help.length);
  console.log('  Contains commands:', help.includes('/zai help') && help.includes('/zai review'));
}

// Запуск тестов
console.log('Running POC tests...\n');
testCommandParsing();
testHelpFormatting();
console.log('\nAll tests completed!');
```

**Запуск тестов:**
```bash
node tests/test.js
```

#### 3.2 Локальное тестирование Worker

**Запуск локального сервера:**
```bash
npm run dev
```

**Тестирование с curl:**
```bash
# Тест webhook с командой /zai help
curl -X POST http://localhost:8787 \
  -H "Content-Type: application/json" \
  -H "X-GitHub-Event: issue_comment" \
  -H "X-Hub-Signature-256: sha256=..." \
  -d '{
    "action": "created",
    "issue": {
      "number": 123,
      "title": "Test issue"
    },
    "comment": {
      "body": "/zai help",
      "user": {
        "login": "testuser"
      }
    },
    "repository": {
      "owner": {
        "login": "testowner"
      },
      "name": "test-repo",
      "full_name": "testowner/test-repo"
    }
  }'
```

#### 3.3 Тестирование на Cloudflare

**Деплой:**
```bash
npm run deploy
```

**Проверка логов:**
```bash
npm run tail
```

**Тестирование через GitHub:**
1. Создать тестовый issue в репозитории
2. Написать комментарий: `/zai help`
3. Проверить, что бот ответил

---

### Фаза 4: Измерение производительности (1 день)

#### 4.1 Метрики для измерения

| Метрика | Инструмент | Цель |
|---------|------------|------|
| Время отклика | Cloudflare Analytics | < 5 секунд |
| Стоимость запроса | Cloudflare Billing | Измерить |
| Успешность | Логи | 100% |
| Задержка | Cloudflare Analytics | Минимизировать |

#### 4.2 Сбор метрик

**Добавить метрики в код:**

```javascript
// В src/index.js
const startTime = Date.now();

// В конце обработки
const duration = Date.now() - startTime;
logger.info('Request processed', {
  durationMs: duration,
  status: result?.status
});
```

**Cloudflare Analytics:**
- Включить в `wrangler.toml`:
```toml
[observability]
enabled = true
```

#### 4.3 Сравнение с GitHub Actions

| Метрика | GitHub Actions | Cloudflare Computer | Разница |
|---------|----------------|---------------------|---------|
| Время отклика | 30-60с | ? | ⬇️ |
| Стоимость | ~$0.02/мин | ? | ⬇️ |
| Надёжность | 99.9% | ? | ⬆️ |

---

### Фаза 5: Документация и отчёт (1 день)

#### 5.1 Документация по настройке

**Файл:** `docs/POC_SETUP.md`

```markdown
# Настройка POC для /zai help

## Предварительные требования

- Akkaunt Cloudflare
- GitHub репозиторий для тестирования
- GitHub Personal Access Token

## Шаги настройки

### 1. Создание Cloudflare Workers проекта

```bash
npm install -g wrangler
wrangler login
wrangler init zai-code-bot-poc
cd zai-code-bot-poc
```

### 2. Копирование кода

Скопируйте файлы из папки `src/` в проект.

### 3. Настройка KV

```bash
# Создать namespace
wrangler kv:namespace create "STATE"
wrangler kv:namespace create "CACHE"

# Получить ID и добавить в wrangler.toml
```

### 4. Настройка секретов

```bash
# Сохранить GitHub Token
wrangler secret put GITHUB_TOKEN

# Сохранить Webhook Secret
wrangler secret put GITHUB_WEBHOOK_SECRET
```

### 5. Настройка GitHub Webhook

1. Перейдите в Settings → Webhooks
2. Добавьте новый webhook
3. URL: `https://zai-code-bot-poc.<account>.workers.dev`
4. Content type: `application/json`
5. Secret: тот же, что и в GITHUB_WEBHOOK_SECRET
6. Events: Issue comments, Pull request review comments

### 6. Деплой

```bash
npm run deploy
```

### 7. Тестирование

Создайте тестовый issue и напишите `/zai help` в комментарии.
```

#### 5.2 Отчёт по результатам POC

**Файл:** `docs/POC_RESULTS.md`

```markdown
# Результаты Proof-of-Concept

## Дата проведения

[Дата]

## Тестовое окружение

- Cloudflare Worker: zai-code-bot-poc
- GitHub репозиторий: [ссылка]
- Количество тестов: [N]

## Результаты

### Производительность

| Метрика | Значение | Цель | Статус |
|---------|----------|------|--------|
| Среднее время отклика | [X] мс | < 5000 мс | ✅/❌ |
| Максимальное время | [X] мс | < 10000 мс | ✅/❌ |
| Минимальное время | [X] мс | - | ✅ |

### Стоимость

| Метрика | Значение | Сравнение с GitHub Actions |
|---------|----------|-----------------------------|
| Стоимость за запрос | [$X] | ⬇️ [Y]% |
| Стоимость за 1000 запросов | [$X] | ⬇️ [Y]% |

### Надёжность

| Метрика | Значение | Статус |
|---------|----------|--------|
| Успешных запросов | [N] | ✅ |
| Неуспешных запросов | [N] | ❌ |
| Процент успеха | [X]% | ✅/❌ |

### Функциональность

- [ ] Обработка команды /zai help
- [ ] Ответ в GitHub комментарии
- [ ] Авторизация пользователей
- [ ] Логирование
- [ ] Мониторинг

## Выводы

### Успехи

- [ ] Удалось перенести команду /zai help
- [ ] Время отклика уменьшилось
- [ ] Стоимость снизилась
- [ ] Архитектура работает

### Проблемы

- [ ] Проблема 1
- [ ] Проблема 2

### Рекомендации

1. Рекомендация 1
2. Рекомендация 2

## Следующие шаги

1. [ ] Перенести следующую команду
2. [ ] Улучшить производительность
3. [ ] Добавить мониторинг
```

---

## 📅 Временной план POC

| Фаза | Задачи | Срок | Статус |
|------|--------|------|--------|
| 0 | Подготовка окружения | 1 день | ⬜ |
| 1 | Базовая инфраструктура | 2 дня | ⬜ |
| 2 | Реализация ядра | 3 дня | ⬜ |
| 3 | Тестирование | 2 дня | ⬜ |
| 4 | Измерение производительности | 1 день | ⬜ |
| 5 | Документация | 1 день | ⬜ |
| **Итого** | | **10 дней** | |

---

## 🎯 Критерии успеха POC

### Минимальные (Must Have)
- [ ] Cloudflare Worker развёрнут и работает
- [ ] GitHub webhook настроен и принимается
- [ ] Команда `/zai help` обрабатывается
- [ ] Ответ публикуется в GitHub
- [ ] Логи пишутся в Cloudflare

### Желательные (Should Have)
- [ ] Авторизация пользователей работает
- [ ] Время отклика < 5 секунд
- [ ] Стоимость измерена и документирована
- [ ] Тесты написаны и проходят
- [ ] Документация по настройке готова

### Опциональные (Nice to Have)
- [ ] Мониторинг настроен
- [ ] Алерты на ошибки
- [ ] Метрики собираются
- [ ] Отчёт по результатам

---

## 🚀 Следующие шаги после POC

Если POC успешен:

1. **Перенести остальные команды**
   - `/zai review` (авто-ревью PR)
   - `/zai ask` (вопросы по коду)
   - `/zai explain` (объяснение кода)
   - `/zai describe` (описание PR)
   - `/zai impact` (анализ влияния)

2. **Перенести запланированные задачи**
   - Обновление AGENTS.md
   - Инициализация AGENTS.md

3. **Перенести CI/CD pipeline**
   - Тестирование
   - Сборка
   - Проверка безопасности

4. **Оптимизировать производительность**
   - Кэширование
   - Масштабирование
   - Оптимизация изолятов

---

## 📚 Полезные ресурсы

### Cloudflare
- [Cloudflare Workers Documentation](https://developers.cloudflare.com/workers/)
- [Cloudflare Computer Documentation](https://blog.cloudflare.com/cloudflare-computer/)
- [Wrangler CLI Documentation](https://developers.cloudflare.com/workers/wrangler/)

### GitHub
- [GitHub Webhooks Documentation](https://docs.github.com/en/webhooks)
- [GitHub API Documentation](https://docs.github.com/en/rest)

### Z.ai
- [Z.ai API Documentation](https://api.z.ai)

---

## 💬 Вопросы и уточнения

Перед началом реализации уточните:

1. **Какой репозиторий использовать для тестирования?**
   - Существующий или создать новый?

2. **Кто будет тестировать?**
   - Только вы или команда?

3. **Есть ли ограничения по времени?**
   - Дедлайн для POC?

4. **Бюджет на Cloudflare?**
   - Есть ли ограничения по расходам?

5. **Нужно ли сохранять совместимость?**
   - Параллельная работа с GitHub Actions?

---

**Статус:** Готов к реализации
**Следующий шаг:** Начать с Фазы 0 (Подготовка окружения)
