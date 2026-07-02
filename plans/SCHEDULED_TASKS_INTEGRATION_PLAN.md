# Zai Code Bot - Scheduled Tasks Integration Plan
## Детальный План Интеграции Периодического Обновления AGENTS.md

**Версия:** 1.0  
**Дата:** 2025-01-15  
**Статус:** Ready for Implementation  
**Автор:** AI Assistant (для AndreiDrang)  

---

## 🎯 Цели и Требования

### Основные требования (от пользователя):

1. ✅ **Интеграция как отдельный хендлер** - Добавить функционал в существующий бот
2. ✅ **Гибкая настройка расписания** - Через YAML файл в проекте
3. ✅ **Автоматическое выполнение** - Бот запускается по расписанию, выполняет команду без вопросов
4. ✅ **Создание PR при изменениях** - Если есть правки в файлах, делает PR в заданную ветку
5. ✅ **Гибкость для будущих команд** - Архитектура должна позволять добавлять другие виды команд

### Технические требования:

- **Источник команд:** Gist URL (https://gist.github.com/AndreiDrang/1580ae796fe56074b600cee6352a5f14)
- **Частота:** Раз в неделю (конфигурируемо)
- **Целевые файлы:** AGENTS.md файлы в репозитории
- **Формат команды:** Команда из Gist должна возвращать структурированные данные (JSON) с информацией о файлах
- **Ветка PR:** Конфигурируемая через YAML

---

## 📊 Текущее Состояние Репозитория

### Уже реализовано:

1. **Базовая архитектура scheduled tasks** (`src/lib/handlers/scheduled.js`)
   - `handleScheduledEvent()` - основной обработчик
   - `executeScheduledTask()` - выполнение отдельной задачи
   - `handleUpdateAgentsTask()` - обработчик для обновления AGENTS.md
   - Реестр обработчиков `SCHEDULED_HANDLERS`

2. **Конфигурация** (`src/lib/config/scheduled-config.js`)
   - Загрузка и валидация `.zai-scheduled.yml`
   - Поддержка версионирования конфигурации
   - Фильтрация задач по расписанию

3. **Утилиты**
   - `fetchFromUrl()` - загрузка содержимого по URL
   - `fetchFileContent()` - получение файла из репозитория
   - `createPR()` - создание Pull Request
   - `updateFileInRepo()` - обновление файла

4. **Интеграция в основной поток** (`src/index.js`)
   - Маршрутизация schedule событий
   - Поддержка в `action.yml`

5. **Конфигурационные файлы**
   - `.zai-scheduled.yml` - конфигурация для этого репозитория
   - `.zai-scheduled.yml.template` - шаблон для пользователей
   - `.github/workflows/zai-agents-update.yml` - пример workflow

6. **Документация**
   - `plans/scheduled-agents-update.md` - начальный план

---

## 🏗️ Архитектура Решения

### Общая Схема

```
┌─────────────────────────────────────────────────────────────────┐
│                      GitHub Actions Event                          │
│                    (schedule: "0 0 * * 1")                        │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                    zai-code-bot Action                             │
│  ┌─────────────────────────────────────────────────────────────┐ │
│  │                  src/index.js (run())                         │ │
│  │  ┌─────────────────────────────────────────────────────────┐  │ │
│  │  │              Event Router (getEventType)                 │  │ │
│  │  │                    ↓                                    │  │ │
│  │  │  ┌─────────────────────┐  ┌─────────────────────────────┐ │  │ │
│  │  │  │   handlePullRequest  │  │   handleScheduledEvent()      │ │  │ │
│  │  │  └─────────────────────┘  └─────────────────────────────┘ │  │ │
│  │  └─────────────────────────────────────────────────────────┘  │ │
│  └─────────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│              src/lib/handlers/scheduled.js                        │
│  ┌─────────────────────────────────────────────────────────────┐ │
│  │  1. Load Config (.zai-scheduled.yml)                         │ │
│  │  2. Filter Tasks by Schedule                                  │ │
│  │  3. For each task:                                          │ │
│  │     ┌─────────────────────────────────────────────────────┐ │ │
│  │     │  executeScheduledTask()                              │ │ │
│  │     │    ┌─────────────────────────────────────────────┐   │ │ │
│  │     │    │  buildExecutionContext()                      │   │ │ │
│  │     │    │    - octokit, apiKey, model, owner, repo      │   │ │ │
│  │     │    │    - targetBranch                              │   │ │ │
│  │     │    │    - Utility functions (fetchFromUrl, etc.)   │   │ │ │
│  │     │    └─────────────────────────────────────────────┘   │ │ │
│  │     │    ┌─────────────────────────────────────────────┐   │ │ │
│  │     │    │  getScheduledHandler(command)                  │   │ │ │
│  │     │    │    ↓                                            │   │ │ │
│  │     │    │  SCHEDULED_HANDLERS[command]()                 │   │ │ │
│  │     │    │    ↓                                            │   │ │ │
│  │     │    │  handleUpdateAgentsTask()                       │   │ │ │
│  │     │    └─────────────────────────────────────────────┘   │ │ │
│  │     └─────────────────────────────────────────────────────┘ │ │
│  └─────────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                    handleUpdateAgentsTask()                        │
│  ┌─────────────────────────────────────────────────────────────┐ │
│  │  1. Get Gist URL (priority: task > defaults > env var)       │ │
│  │  2. Fetch content from Gist                                  │ │
│  │  3. Execute command (via Z.ai API)                           │ │
│  │  4. Parse response for file updates                          │ │
│  │  5. Compare with existing files                              │ │
│  │  6. If changes: create PR                                    │ │
│  │  7. Return result                                            │ │
│  └─────────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────────┘
```

### Ключевые Компоненты

#### 1. Конфигурация (`.zai-scheduled.yml`)

```yaml
version: 1

defaults:
  branch: main
  schedule: "0 0 * * 1"  # Каждый понедельник в 00:00 UTC
  gist_url: https://gist.githubusercontent.com/AndreiDrang/1580ae796fe56074b600cee6352a5f14/raw

tasks:
  - id: weekly-agents-update
    name: "Weekly AGENTS.md Update"
    enabled: true
    schedule: "0 0 * * 1"
    command: update-agents
    config:
      branch: main
      pr_title: "chore: update AGENTS.md files"
      pr_body: "Automated weekly update..."
      commit_message: "docs: update AGENTS.md from scheduled task"
```

#### 2. Workflow (`.github/workflows/zai-scheduled.yml`)

```yaml
name: Zai Scheduled Tasks

on:
  schedule:
    - cron: "0 0 * * 1"
  workflow_dispatch:

permissions:
  contents: write
  pull-requests: write

jobs:
  zai-scheduled:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0

      - uses: AndreiDrang/zai-code-bot@main
        with:
          ZAI_API_KEY: ${{ secrets.ZAI_API_KEY }}
          ZAI_MODEL: ${{ vars.ZAI_MODEL }}
          ZAI_SCHEDULED_ENABLED: "true"
          ZAI_AGENTS_GIST_URL: ${{ vars.ZAI_AGENTS_GIST_URL }}
```

#### 3. Обработчик AGENTS.md (`handleUpdateAgentsTask`)

**Алгоритм:**
1. Получаем Gist URL из конфигурации
2. Загружаем содержимое Gist
3. Исполняем команду через Z.ai API
4. Парсим ответ (ожидаем JSON с файлами)
5. Сравниваем с текущими файлами
6. Создаём PR если есть изменения

---

## 📋 Детальный План Интеграции

### Фаза 1: Подготовка и Анализ ✅ (УЖЕ ВЫПОЛНЕНО)

- [x] Проанализировать текущий репозиторий
- [x] Выявить существующую функциональность
- [x] Определить пробелы и возможности для улучшения
- [x] Создать этот детальный план

**Результат:** Этот документ

---

### Фаза 2: Улучшение Существующей Реализации (Опционально)

Хотя функционал уже работает, можно сделать его более гибким и надёжным:

#### 2.1. Улучшение конфигурации

**Файл:** `src/lib/config/scheduled-config.js`

**Изменения:**
- [ ] Добавить валидацию cron-выражений
- [ ] Добавить поддержку переменных окружения в конфигурации (например, `${{ env.MY_VAR }}`)
- [ ] Улучшить ошибки валидации

**Пример улучшенной валидации:**
```javascript
function validateCronExpression(cron) {
  const cronRegex = /^(\*|[0-9]|[0-5][0-9]) (\*|[0-9]|1[0-9]|2[0-3]) (\*|[0-9]|[12][0-9]|3[01]) (\*|[0-9]|1[0-2]) (\*|[0-6])$/;
  if (!cronRegex.test(cron)) {
    throw new Error(`Invalid cron expression: ${cron}`);
  }
}
```

#### 2.2. Улучшение обработчика scheduled.js

**Файл:** `src/lib/handlers/scheduled.js`

**Изменения:**
- [ ] Добавить более детальное логирование
- [ ] Улучшить обработку ошибок
- [ ] Добавить метрики выполнения
- [ ] Добавить поддержку кэширования (чтобы не выполнять одну и ту же задачу несколько раз)

**Пример улучшенного логирования:**
```javascript
logger.info(`[Task ${task.id}] Starting execution`, {
  taskId: task.id,
  command: task.command,
  timestamp: new Date().toISOString(),
});
```

#### 2.3. Улучшение парсинга ответа от Z.ai

**Файл:** `src/lib/handlers/scheduled.js`

**Изменения:**
- [ ] Улучшить парсинг JSON из ответа Z.ai
- [ ] Добавить валидацию структуры ответа
- [ ] Добавить fallback-механизмы

**Пример улучшенного парсинга:**
```javascript
function parseFileUpdatesFromResponse(responseContent, logger) {
  // Пробуем разные форматы ответа
  const formats = [
    // Формат 1: Прямой JSON
    (text) => {
      try { return JSON.parse(text); } catch { return null; }
    },
    // Формат 2: JSON в markdown код-блоке
    (text) => {
      const match = text.match(/```(?:json)?\n([\s\S]*?)\n```/);
      if (match) {
        try { return JSON.parse(match[1]); } catch { return null; }
      }
      return null;
    },
    // Формат 3: JSON в ответе после текста
    (text) => {
      const match = text.match(/\{[\s\S]*\}/);
      if (match) {
        try { return JSON.parse(match[0]); } catch { return null; }
      }
      return null;
    }
  ];
  
  for (const parser of formats) {
    const result = parser(responseContent);
    if (result) {
      logger.info('Successfully parsed response as JSON');
      return result;
    }
  }
  
  logger.warn('Could not parse response as JSON, trying fallback');
  // Fallback логика...
}
```

---

### Фаза 3: Документация и Примеры

#### 3.1. Обновить README.md

**Файл:** `README.md`

**Добавления:**
- [ ] Раздел "Scheduled Tasks"
- [ ] Описание конфигурации
- [ ] Примеры использования
- [ ] Ссылки на документацию

**Пример добавления:**
```markdown
## Scheduled Tasks

Zai Code Bot supports automated tasks that run on a schedule, such as:

- **AGENTS.md Updates**: Automatically update AGENTS.md files from a Gist URL
- **Custom Commands**: Execute any command on a schedule

### Configuration

Create a `.zai-scheduled.yml` file in your repository:

```yaml
version: 1

defaults:
  branch: main
  schedule: "0 0 * * 0"
  gist_url: https://gist.githubusercontent.com/AndreiDrang/1580ae796fe56074b600cee6352a5f14/raw

tasks:
  - id: weekly-agents-update
    command: update-agents
    config:
      pr_title: "chore: update AGENTS.md files"
```

See [Scheduled Tasks Documentation](docs/scheduled-tasks.md) for details.
```

#### 3.2. Создать документацию для пользователей

**Новый файл:** `docs/scheduled-tasks.md`

**Содержание:**
- Введение
- Установка и настройка
- Конфигурация задач
- Доступные команды
- Примеры
- Устранение неполадок
- Часто задаваемые вопросы

#### 3.3. Обновить шаблон конфигурации

**Файл:** `.zai-scheduled.yml.template`

**Изменения:**
- [ ] Добавить больше примеров
- [ ] Улучшить комментарии
- [ ] Добавить секцию с часто используемыми cron-выражениями

---

### Фаза 4: Тестирование

#### 4.1. Unit-тесты

**Файлы:** `tests/unit/scheduled-config.test.js`, `tests/unit/handlers/scheduled.test.js`

**Покрытие:**
- [ ] Загрузка и валидация конфигурации
- [ ] Фильтрация задач по расписанию
- [ ] Парсинг ответа от Z.ai
- [ ] Создание PR
- [ ] Обработка ошибок

**Пример теста:**
```javascript
const { validateAndNormalizeConfig } = require('../../src/lib/config/scheduled-config');

describe('Scheduled Config Validation', () => {
  test('should validate basic config', () => {
    const config = {
      version: 1,
      defaults: { branch: 'main' },
      tasks: [{ id: 'test', command: 'update-agents' }]
    };
    
    const result = validateAndNormalizeConfig(config);
    expect(result).toBeDefined();
    expect(result.tasks[0].enabled).toBe(true);
  });
  
  test('should throw on invalid version', () => {
    const config = { version: 2, tasks: [] };
    expect(() => validateAndNormalizeConfig(config)).toThrow();
  });
});
```

#### 4.2. Интеграционные тесты

**Файл:** `tests/integration/scheduled.test.js`

**Покрытие:**
- [ ] Полный цикл выполнения задачи
- [ ] Взаимодействие с GitHub API
- [ ] Взаимодействие с Z.ai API

#### 4.3. Manual Testing

**Сценарии:**
- [ ] Запуск задачи по расписанию
- [ ] Запуск задачи вручную (workflow_dispatch)
- [ ] Задача без изменений (не создаёт PR)
- [ ] Задача с изменениями (создаёт PR)
- [ ] Ошибка в конфигурации
- [ ] Ошибка в выполнении команды

---

### Фаза 5: Доработка и Оптимизация

#### 5.1. Оптимизация производительности

- [ ] Кэширование конфигурации
- [ ] Параллельное выполнение задач (с ограничением)
- [ ] Оптимизация запросов к GitHub API

#### 5.2. Улучшение UX

- [ ] Логи в GitHub Actions с эмодзи и цветами
- [ ] Прогресс-бары для долгих операций
- [ ] Сводка выполнения в конце

#### 5.3. Расширяемость

- [ ] Документация по добавлению новых команд
- [ ] Примеры кастомных обработчиков
- [ ] Шаблоны для новых типов задач

---

## 🔧 Технические Детали Реализации

### Алгоритм handleUpdateAgentsTask

```
1. ПОЛУЧЕНИЕ KONФИГУРАЦИИ
   ├─ Gist URL из: task.config.gist_url → config.defaults.gist_url → env.ZAI_AGENTS_GIST_URL
   ├─ Target branch из: task.config.branch → config.defaults.branch → 'main'
   └─ PR параметры из: task.config (pr_title, pr_body, commit_message)

2. ЗАГРУЗКА КОМАНДЫ ИЗ GIST
   ├─ Проверка URL
   ├─ HTTP GET запрос
   └─ Обработка ошибок (timeout, 404, invalid content)

3. ИСПОЛНЕНИЕ КОМАНДЫ
   ├─ Проверка, что команда не пустая
   ├─ Формирование prompt для Z.ai API
   │  └─ Включает: repository info, branch, command text
   ├─ Вызов Z.ai API (с retry логикой)
   └─ Парсинг ответа

4. ПАРСИНГ ОТВЕТА
   ├─ Попытка 1: Прямой JSON
   ├─ Попытка 2: JSON в markdown код-блоке
   ├─ Попытка 3: JSON в тексте ответа
   └─ Fallback: Использовать весь ответ как содержимое AGENTS.md

5. ОПРЕДЕЛЕНИЕ ИЗМЕНЕНИЙ
   ├─ Для каждого файла из ответа:
   │  ├─ Получение текущего содержимого из репозитория
   │  ├─ Сравнение с новым содержимым
   │  └─ Маркировка как changed/unchanged
   └─ Фильтрация только изменённых файлов

6. СОЗДАНИЕ PR (если есть изменения)
   ├─ Создание ветки (zai-scheduled/yyyy.mm.dd_hh.mm)
   ├─ Применение всех изменений файлов
   ├─ Создание коммита
   └─ Создание Pull Request

7. ВОЗВРАТ РЕЗУЛЬТАТА
   └─ { success, changes, prCreated, prNumber, prUrl, message }
```

### Формат ответа от Z.ai

Ожидаемый формат (JSON):

```json
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
      "action": "updated"
    }
  ]
}
```

### Пример команды в Gist

Команда в Gist должна быть в формате, который Z.ai поймёт. Например:

```
/init-agentsmd

You are an AI assistant. Scan this repository and generate comprehensive AGENTS.md files.

Requirements:
1. Find all AGENTS.md files in the repository
2. For each file, analyze the directory context
3. Generate appropriate AGENTS.md content based on the code in that directory
4. Return JSON with all files that need to be created or updated

Return ONLY valid JSON, no other text.
```

---

## 📁 Структура Файлов Проекта

```
zai-code-bot/
├── src/
│   ├── index.js                    # Главный файл, маршрутизация событий
│   ├── lib/
│   │   ├── events.js               # Определение типов событий
│   │   ├── commands.js             # Парсинг команд
│   │   ├── config/
│   │   │   └── scheduled-config.js # Загрузка и валидация конфигурации
│   │   └── handlers/
│   │       ├── index.js           # Экспорт всех обработчиков
│   │       ├── scheduled.js        # Обработчик scheduled событий
│   │       ├── ask.js              # Обработчик /zai ask
│   │       ├── review.js           # Обработчик /zai review
│   │       ├── explain.js          # Обработчик /zai explain
│   │       ├── describe.js         # Обработчик /zai describe
│   │       ├── impact.js           # Обработчик /zai impact
│   │       └── help.js             # Обработчик /zai help
│   └── ...
├── action.yml                      # Конфигурация GitHub Action
├── .zai-scheduled.yml             # Конфигурация scheduled tasks (для этого репо)
├── .zai-scheduled.yml.template     # Шаблон конфигурации
├── .github/
│   └── workflows/
│       ├── zai-code-bot.yml        # Основной workflow
│       └── zai-agents-update.yml   # Workflow для обновления AGENTS.md
├── plans/
│   ├── scheduled-agents-update.md  # Начальный план
│   └── SCHEDULED_TASKS_INTEGRATION_PLAN.md  # Этот документ
├── docs/
│   └── scheduled-tasks.md          # Документация (планируется)
└── tests/
    ├── unit/
    │   └── scheduled.test.js        # Unit-тесты
    └── integration/
        └── scheduled.test.js        # Интеграционные тесты
```

---

## 🎯 Критерии Успеха

### MVP (Minimum Viable Product)

- [x] Обнаружение и маршрутизация schedule событий
- [x] Загрузка и валидация конфигурации
- [x] Исполнение задачи update-agents
- [x] Создание PR при изменениях
- [x] Нет PR при отсутствии изменений
- [x] Обработка ошибок
- [ ] Все существующие тесты проходят
- [ ] Новые тесты покрывают 80%+ нового кода

### Quality Gates

- [ ] Нет breaking changes для существующего функционала
- [ ] Проверка безопасности
- [ ] Приемлемая производительность
- [ ] Полная документация

---

## 🚀 Следующие Шаги

### Непосредственные действия:

1. **Обсудить этот план** с командой
2. **Принять решение** по приоритетам (что реализовывать в первую очередь)
3. **Распределить задачи** между участниками
4. **Начать реализацию** с Фазы 2 (улучшение существующего)

### Долгосрочные планы:

1. Добавить поддержку других типов задач (например, sync-docs, cleanup, etc.)
2. Реализовать UI для управления задачами через GitHub Issues
3. Добавить мониторинг и алерты для scheduled tasks
4. Реализовать dashboard для просмотра статуса задач

---

## 📚 Полезные Ресурсы

### GitHub Actions
- [Schedule Events](https://docs.github.com/en/actions/using-workflows/events-that-trigger-workflows#schedule)
- [Workflow Syntax](https://docs.github.com/en/actions/using-workflows/workflow-syntax-for-github-actions)
- [Cron Syntax](https://docs.github.com/en/actions/using-workflows/events-that-trigger-workflows#schedule)

### GitHub API
- [Octokit Documentation](https://github.com/octokit/octokit.js)
- [Repos API](https://docs.github.com/en/rest/repos/repos)
- [Pull Requests API](https://docs.github.com/en/rest/pulls/pulls)

### YAML
- [YAML Specification](https://yaml.org/spec/1.2/spec.html)
- [js-yaml Documentation](https://github.com/nodeca/js-yaml)

### Z.ai API
- [Z.ai API Documentation](https://api.z.ai/)

---

## 🔍 Вопросы и Ответы

### Q: Можно ли запускать задачи вручную?
**A:** Да, используйте `workflow_dispatch` в workflow файле:
```yaml
on:
  schedule:
    - cron: "0 0 * * 1"
  workflow_dispatch:
```

### Q: Как отладить задачу?
**A:** 
1. Запустите workflow вручную через GitHub UI
2. Посмотрите логи в Actions
3. Используйте `ACT=debug` для детального логирования

### Q: Что делать, если команда в Gist возвращает невалидный JSON?
**A:** Бот попробует несколько форматов парсинга. Если всё равно не получается, он использует весь ответ как содержимое AGENTS.md файла.

### Q: Можно ли использовать разные Gist URL для разных задач?
**A:** Да, вы можете указать `gist_url` на уровне задачи:
```yaml
tasks:
  - id: task1
    command: update-agents
    config:
      gist_url: https://gist.github.com/user1/gist1
  - id: task2
    command: update-agents
    config:
      gist_url: https://gist.github.com/user2/gist2
```

### Q: Как добавить свою кастомную команду?
**A:** 
1. Создайте обработчик в `src/lib/handlers/scheduled.js`
2. Зарегистрируйте его в `SCHEDULED_HANDLERS`
3. Используйте её в конфигурации:
```yaml
tasks:
  - id: my-task
    command: my-custom-command
```

---

## 📝 История Изменений

| Дата | Версия | Описание | Автор |
|------|--------|----------|-------|
| 2025-01-15 | 1.0 | Initial integration plan | AI Assistant |

---

**Статус:** ✅ Ready for Review  
**Следующий шаг:** Создать PR с этим планом в main ветку
