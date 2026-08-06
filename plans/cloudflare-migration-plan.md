# План миграции zai-code-bot с GitHub Actions на Cloudflare Computer

## 📋 Обзор

Цель: Перенести все функции zai-code-bot с GitHub Actions на Cloudflare Computer для повышения производительности, масштабируемости и снижения затрат.

## 🎯 Текущая архитектура

### GitHub Actions Workflows

1. **zai-code-bot.yml** - Основной workflow
   - Триггеры: PR events, issue_comment, pull_request_review_comment
   - Функции: Авто-ревью кода, обработка команд /zai
   - Использует: `@actions/core`, `@actions/github`, Z.ai API

2. **ci.yml** - CI/CD pipeline
   - Триггеры: push на main, PR на main
   - Функции: Тестирование, сборка, проверка безопасности
   - Matrix: Node.js 20, 22

3. **zai-agents-update.yml** - Обновление AGENTS.md
   - Триггеры: schedule (каждый понедельник), workflow_dispatch
   - Функции: Автоматическое обновление AGENTS.md из Gist

4. **zai-agents-init-example.yml** - Инициализация AGENTS.md
   - Триггеры: schedule, workflow_dispatch
   - Функции: Инициализация AGENTS.md из шаблона

### Основные компоненты бота

- **src/index.js** - Основная логика обработки событий
- **src/lib/handlers/** - Обработчики команд (/zai ask, review, explain, describe, impact)
- **src/lib/auto-review.js** - Автоматическое ревью PR
- **src/lib/changed-files.js** - Получение изменённых файлов
- **src/lib/api.js** - Работа с Z.ai API
- **src/lib/auth.js** - Авторизация и проверка прав
- **src/lib/comments.js** - Работа с комментариями GitHub
- **src/lib/scheduled.js** - Обработка запланированных задач

## 🚀 Новая архитектура на Cloudflare Computer

### Преимущества Cloudflare Computer

1. **Изоляты** - Лёгкие задачи (обработка команд, анализ кода)
2. **Контейнеры** - Тяжёлые задачи (запуск тестов, сборка)
3. **Масштабируемость** - Автоматическое масштабирование под нагрузку
4. **Изоляция** - Безопасная файловая система для каждого запроса
5. **Интеграция с GitHub** - Клонирование репозиториев, работа с API

### Архитектура

```
┌─────────────────────────────────────────────────────────────┐
│                    Cloudflare Computer                          │
├─────────────────────────────────────────────────────────────┤
│                                                                  │
│  ┌─────────────────┐    ┌─────────────────┐    ┌───────────┐ │
│  │  GitHub Webhook  │───▶│  Event Router   │───▶│  Isolate   │ │
│  │  (PR, Issues)    │    │  (index.js)     │    │  (Handler) │ │
│  └─────────────────┘    └─────────────────┘    └───────────┘ │
│                           │                                  │
│                           ▼                                  │
│  ┌─────────────────┐    ┌─────────────────┐              │
│  │  Z.ai API       │◀───│  API Client      │              │
│  │  (Chat, Coding)  │    │  (api.js)        │              │
│  └─────────────────┘    └─────────────────┘              │
│                                                                  │
│  ┌─────────────────┐    ┌─────────────────┐              │
│  │  GitHub API      │◀───│  GitHub Client   │              │
│  │  (Comments, PRs) │    │  (github.js)     │              │
│  └─────────────────┘    └─────────────────┘              │
│                                                                  │
└─────────────────────────────────────────────────────────────┘
```

## 📊 План миграции

### Фаза 1: Подготовка (Неделя 1)

#### 1.1 Настройка Cloudflare Computer
- [ ] Создать аккаунт Cloudflare и настроить Workers
- [ ] Установить `@cloudflare/computer` SDK
- [ ] Настроить аутентификацию и API ключи
- [ ] Создать новый проект для zai-code-bot

#### 1.2 Анализ зависимостей
- [ ] Проанализировать текущие зависимости (`@actions/core`, `@actions/github`)
- [ ] Найти аналоги в Cloudflare Computer или разработать адаптеры
- [ ] Определить, какие функции нужно переписать

#### 1.3 Настройка окружения
- [ ] Создать конфигурационные файлы для Cloudflare
- [ ] Настроить переменные окружения и секреты
- [ ] Создать тестовое окружение для разработки

### Фаза 2: Разработка ядра (Недели 2-3)

#### 2.1 Адаптация основной логики
- [ ] **src/index.js** - Заменить `@actions/core` на Cloudflare Computer API
  - Заменить `core.getInput()` на `process.env` или Cloudflare KV
  - Заменить `core.setOutput()` на логирование или ответ через API
  - Адаптировать обработку событий GitHub

- [ ] **src/lib/api.js** - Адаптировать для работы с Cloudflare
  - Заменить HTTP клиент на Cloudflare fetch
  - Настроить кэширование через Cloudflare Cache API

- [ ] **src/lib/auth.js** - Проверка авторизации
  - Адаптировать для работы с GitHub API через Cloudflare
  - Настроить проверку токенов

#### 2.2 Обработчики команд
- [ ] **src/lib/handlers/ask.js** - Обработка /zai ask
- [ ] **src/lib/handlers/review.js** - Авто-ревью PR
- [ ] **src/lib/handlers/explain.js** - Объяснение кода
- [ ] **src/lib/handlers/describe.js** - Генерация описания PR
- [ ] **src/lib/handlers/impact.js** - Анализ влияния изменений
- [ ] **src/lib/handlers/scheduled.js** - Запланированные задачи

#### 2.3 Работа с GitHub
- [ ] **src/lib/comments.js** - Работа с комментариями
  - Адаптировать для Cloudflare Computer GitHub клиента
- [ ] **src/lib/changed-files.js** - Получение изменённых файлов
  - Оптимизировать для работы в изолированной ФС
- [ ] **src/lib/events.js** - Обработка событий
  - Адаптировать для Cloudflare webhook обработки

### Фаза 3: Миграция workflows (Недели 4-5)

#### 3.1 Основной workflow (zai-code-bot.yml)
```javascript
// Новая архитектура на Cloudflare Computer
import { Computer } from '@cloudflare/computer';

const computer = new Computer({
  // Конфигурация изолята
  isolate: {
    memory: '128MB',
    cpu: '10ms',
    timeout: '30s'
  }
});

// Обработчик GitHub webhook
export default {
  async fetch(request, env) {
    const { event, repository, pull_request, comment } = await request.json();
    
    // Маршрутизация событий
    switch(event) {
      case 'pull_request':
        return handlePullRequest(computer, repository, pull_request);
      case 'issue_comment':
        return handleIssueComment(computer, repository, comment);
      case 'pull_request_review_comment':
        return handleReviewComment(computer, repository, comment);
    }
  }
}
```

#### 3.2 CI/CD workflow (ci.yml)
- [ ] Перенести тестирование на Cloudflare Computer
  - Использовать контейнеры для запуска `npm test`
  - Настроить кэширование зависимостей
- [ ] Перенести сборку на Cloudflare Computer
  - Использовать контейнеры для `npm run build`
- [ ] Перенести проверку безопасности
  - Использовать изоляты для `npm audit`

#### 3.3 Запланированные задачи
- [ ] Перенести zai-agents-update.yml
  - Использовать Cloudflare Cron Triggers
  - Настроить автоматические обновления
- [ ] Перенести zai-agents-init-example.yml
  - Интегрировать с cron триггерами

### Фаза 4: Тестирование (Неделя 6)

#### 4.1 Юнит-тестирование
- [ ] Тестирование обработчиков команд
- [ ] Тестирование API клиента
- [ ] Тестирование авторизации
- [ ] Тестирование работы с GitHub

#### 4.2 Интеграционное тестирование
- [ ] Тестирование с реальными PR
- [ ] Тестирование с реальными issues
- [ ] Тестирование запланированных задач
- [ ] Тестирование CI/CD pipeline

#### 4.3 Нагрузочное тестирование
- [ ] Тестирование под нагрузкой
- [ ] Оптимизация производительности
- [ ] Настройка авто-масштабирования

### Фаза 5: Деплой и мониторинг (Неделя 7)

#### 5.1 Деплой
- [ ] Деплой в продакшн
- [ ] Настройка мониторинга
- [ ] Настройка логгирования
- [ ] Настройка алертов

#### 5.2 Мониторинг
- [ ] Cloudflare Analytics
- [ ] Логи ошибок
- [ ] Метрики производительности
- [ ] Метрики использования

## 🔧 Технические детали

### Зависимости для замены

| Текущая | Замена в Cloudflare |
|---------|-------------------|
| `@actions/core` | `process.env` + Cloudflare KV |
| `@actions/github` | `@cloudflare/computer` GitHub client |
| `node:https` | Cloudflare fetch API |
| GitHub Actions secrets | Cloudflare KV / Secrets |

### Конфигурация изолята

```javascript
// Конфигурация для лёгких задач (обработка команд)
const lightIsolate = {
  memory: '128MB',
  cpu: '10ms',
  timeout: '30s',
  filesystem: {
    '/repo': { size: '1GB' }  // Для клонирования репозитория
  }
};

// Конфигурация для тяжёлых задач (тестирование, сборка)
const heavyContainer = {
  memory: '4GB',
  cpu: '100ms',
  timeout: '10m',
  filesystem: {
    '/repo': { size: '10GB' },
    '/node_modules': { size: '5GB' }
  }
};
```

### Обработка GitHub событий

```javascript
// Пример обработки PR события
async function handlePullRequest(computer, repository, pull_request) {
  const isolate = await computer.isolate.create({
    ...lightIsolate,
    // Передаём контекст в изолят
    env: {
      REPOSITORY: JSON.stringify(repository),
      PULL_REQUEST: JSON.stringify(pull_request),
      ZAI_API_KEY: env.ZAI_API_KEY,
      GITHUB_TOKEN: env.GITHUB_TOKEN
    }
  });
  
  // Запускаем обработчик в изоляте
  const result = await isolate.run(`
    const { handlePullRequest } = require('./dist/index.js');
    const repository = JSON.parse(process.env.REPOSITORY);
    const pull_request = JSON.parse(process.env.PULL_REQUEST);
    
    await handlePullRequest({
      repository,
      pull_request,
      apiKey: process.env.ZAI_API_KEY,
      githubToken: process.env.GITHUB_TOKEN
    });
  `);
  
  return new Response(JSON.stringify(result), {
    headers: { 'Content-Type': 'application/json' }
  });
}
```

## ⚡ Оптимизации

### 1. Кэширование
- Кэшировать клонированные репозитории
- Кэшировать npm зависимости
- Кэшировать результаты Z.ai API

### 2. Масштабирование
- Автоматическое масштабирование изолятов
- Очереди для тяжёлых задач
- Приоритезация задач

### 3. Безопасность
- Изоляция каждого запроса
- Ограничение доступа к секретам
- Проверка авторизации

## 📈 Ожидаемые результаты

### Производительность
- ⬇️ Время отклика: с 30-60с до 5-10с
- ⬆️ Пропускная способность: в 10-100 раз
- ⬇️ Стоимость: на 50-70% дешевле

### Надёжность
- ⬆️ Доступность: 99.99%
- ⬆️ Отказоустойчивость
- ⬆️ Масштабируемость

### Разработка
- ⬆️ Скорость разработки
- ⬆️ Лёгкость тестирования
- ⬆️ Гибкость конфигурации

## 🎯 Следующие шаги

1. **Создать репозиторий для новой версии**
   ```bash
   git checkout -b cloudflare-migration
   ```

2. **Установить зависимости Cloudflare**
   ```bash
   npm install @cloudflare/computer @cloudflare/workers
   ```

3. **Создать базовую структуру**
   ```
   zai-cloudflare/
   ├── src/
   │   ├── index.js          # Основной обработчик
   │   ├── handlers/         # Обработчики команд
   │   ├── lib/              # Вспомогательные функции
   │   └── config/           # Конфигурация
   ├── wrangler.toml         # Конфигурация Cloudflare
   └── package.json
   ```

4. **Начать с простого обработчика**
   - Реализовать обработку `/zai help`
   - Протестировать локально
   - Деплоить на Cloudflare

## 📚 Ресурсы

- [Cloudflare Computer Documentation](https://blog.cloudflare.com/cloudflare-computer/)
- [GitHub Webhooks Documentation](https://docs.github.com/en/webhooks)
- [Z.ai API Documentation](https://api.z.ai)

---

**Статус:** Готов к обсуждению и уточнению деталей
**Следующий шаг:** Начать реализацию Фазы 1
