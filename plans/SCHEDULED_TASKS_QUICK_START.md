# Scheduled Tasks - Quick Start Guide

## 🚀 Быстрый старт

Этот гайд поможет быстро настроить периодическое обновление AGENTS.md файлов в вашем репозитории.

---

## ⚡ Быстрая настройка (3 шага)

### Шаг 1: Создайте конфигурационный файл

Создайте файл `.zai-scheduled.yml` в корне вашего репозитория:

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
      pr_body: "Automated weekly update of AGENTS.md files"
      commit_message: "docs: update AGENTS.md from scheduled task"
```

### Шаг 2: Создайте workflow файл

Создайте файл `.github/workflows/zai-scheduled.yml`:

```yaml
name: Zai Scheduled Tasks

on:
  schedule:
    - cron: "0 0 * * 1"
  workflow_dispatch:  # Для ручного запуска

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
          ZAI_MODEL: ${{ vars.ZAI_MODEL || 'glm-5.2' }}
          ZAI_SCHEDULED_ENABLED: "true"
          ZAI_AGENTS_GIST_URL: ${{ vars.ZAI_AGENTS_GIST_URL }}
        env:
          GITHUB_TOKEN: ${{ github.token }}
```

### Шаг 3: Настройте secrets и variables

В настройках вашего репозитория (Settings > Secrets and variables > Actions):

1. **Secrets:**
   - `ZAI_API_KEY` - ваш API ключ от Z.ai

2. **Variables (опционально):**
   - `ZAI_MODEL` - модель Z.ai (по умолчанию: glm-5.2)
   - `ZAI_AGENTS_GIST_URL` - URL вашего Gist файла (если не указан в .zai-scheduled.yml)

---

## 📋 Конфигурация

### Структура .zai-scheduled.yml

```yaml
version: 1  # Обязательно

defaults:    # Значения по умолчанию для всех задач
  branch: main              # Целевая ветка для PR
  schedule: "0 0 * * 0"      # Расписание по умолчанию
  gist_url: URL             # URL Gist файла по умолчанию

tasks:       # Список задач
  - id: unique-id           # Уникальный идентификатор
    name: "Task Name"       # Имя задачи (для логов)
    enabled: true          # Включена ли задача
    schedule: "0 0 * * 1"   # Расписание (переопределяет defaults)
    command: update-agents  # Команда для выполнения
    config:                # Конфигурация задачи
      branch: main         # Целевая ветка (переопределяет defaults)
      gist_url: URL        # URL Gist файла (переопределяет defaults)
      pr_title: "..."      # Заголовок PR
      pr_body: "..."       # Описание PR
      commit_message: "..." # Сообщение коммита
```

### Приоритет конфигурации

1. **task.config.*** (на уровне задачи)
2. **defaults.*** (на уровне дефолтов)
3. **Переменные окружения** (ZAI_AGENTS_GIST_URL, etc.)

---

## 🎯 Доступные команды

### `update-agents`

**Описание:** Обновляет AGENTS.md файлы из Gist URL

**Конфигурация:**
```yaml
config:
  branch: main              # Целевая ветка
  gist_url: URL            # URL Gist файла с командой
  pr_title: "..."          # Заголовок PR
  pr_body: "..."           # Описание PR
  commit_message: "..."    # Сообщение коммита
```

**Как работает:**
1. Загружает команду из Gist URL
2. Исполняет команду через Z.ai API
3. Парсит ответ (ожидает JSON с файлами)
4. Сравнивает с текущими файлами
5. Создаёт PR если есть изменения

**Формат Gist:**
Команда в Gist должна возвращать JSON в формате:

```json
{
  "summary": "Описание изменений",
  "files": [
    {
      "path": "AGENTS.md",
      "content": "... содержимое файла ...",
      "action": "created|updated|unchanged"
    }
  ]
}
```

---

## 📅 Cron Syntax

Формат: `minute hour day-of-month month day-of-week`

| Поле | Значения | Пример |
|------|----------|--------|
| Minute | 0-59 | `0` |
| Hour | 0-23 | `12` |
| Day of month | 1-31 | `15` |
| Month | 1-12 | `6` |
| Day of week | 0-6 (0=Sun) | `1` (Понедельник) |

### Примеры:

```yaml
# Каждый день в полночь
schedule: "0 0 * * *"

# Каждый понедельник в полночь
schedule: "0 0 * * 1"

# Каждый день в 9:00
schedule: "0 9 * * *"

# Каждый час
schedule: "0 * * * *"

# Каждые 6 часов
schedule: "0 */6 * * *"

# Каждый будний день в 9:00
schedule: "0 9 * * 1-5"
```

**⚠️ Важно:** GitHub Actions использует **UTC**!

---

## 🔍 Устранение неполадок

### Проблема: Задача не запускается

**Проверьте:**
- [ ] Workflow файл в `.github/workflows/`
- [ ] Event `schedule` или `workflow_dispatch` в `on:`
- [ ] Permission `contents: write` и `pull-requests: write`
- [ ] Secrets `ZAI_API_KEY` настроен

### Проблема: Нет PR при изменениях

**Проверьте:**
- [ ] Gist URL доступен и возвращает валидный контент
- [ ] Команда в Gist возвращает валидный JSON
- [ ] Файлы действительно изменились
- [ ] Ветка для PR существует

### Проблема: Ошибка парсинга JSON

**Решения:**
1. Проверьте формат ответа от Z.ai
2. Убедитесь, что ответ содержит валидный JSON
3. Используйте [JSON Validator](https://jsonlint.com/) для проверки

---

## 📊 Логирование и мониторинг

### Просмотр логов

1. Перейдите в **Actions** таб вашего репозитория
2. Выберите workflow **Zai Scheduled Tasks**
3. Посмотрите логи последнего запуска

### Уровни логирования

- `INFO` - Основные события (по умолчанию)
- `DEBUG` - Детальная информация (установите `ACT=debug`)
- `WARN` - Предупреждения
- `ERROR` - Ошибки

---

## 🔧 Расширенная настройка

### Несколько задач

```yaml
tasks:
  - id: weekly-agents-update
    command: update-agents
    schedule: "0 0 * * 1"
    config:
      gist_url: https://gist.github.com/user/gist1
      pr_title: "Update main AGENTS.md"

  - id: daily-docs-sync
    command: update-agents
    schedule: "0 12 * * *"
    config:
      gist_url: https://gist.github.com/user/gist2
      pr_title: "Daily docs sync"
```

### Кастомные обработчики

Чтобы добавить свою команду:

1. Добавьте обработчик в `src/lib/handlers/scheduled.js`:

```javascript
async function handleMyCustomTask(context) {
  const { octokit, owner, repo, logger } = context;
  
  // Ваша логика здесь
  logger.info('Executing custom task');
  
  return {
    success: true,
    changes: [],
    message: 'Custom task completed'
  };
}
```

2. Зарегистрируйте обработчик:

```javascript
const SCHEDULED_HANDLERS = {
  'update-agents': handleUpdateAgentsTask,
  'my-custom': handleMyCustomTask,  // Новый обработчик
};
```

3. Используйте в конфигурации:

```yaml
tasks:
  - id: my-task
    command: my-custom
    config:
      # Ваши параметры
```

---

## 🎓 Примеры

### Пример 1: Еженедельное обновление AGENTS.md

**.zai-scheduled.yml:**
```yaml
version: 1

defaults:
  branch: main
  gist_url: https://gist.githubusercontent.com/AndreiDrang/1580ae796fe56074b600cee6352a5f14/raw

tasks:
  - id: weekly-update
    command: update-agents
    schedule: "0 0 * * 1"
    config:
      pr_title: "chore: weekly AGENTS.md update"
```

### Пример 2: Ежедневная синхронизация в 9:00

**.zai-scheduled.yml:**
```yaml
version: 1

defaults:
  branch: develop
  schedule: "0 9 * * *"

tasks:
  - id: daily-sync
    command: update-agents
    config:
      gist_url: https://gist.github.com/myuser/my-gist/raw
      pr_title: "docs: daily sync"
      commit_message: "docs: sync from gist"
```

### Пример 3: Несколько задач с разными расписаниями

**.zai-scheduled.yml:**
```yaml
version: 1

defaults:
  branch: main

tasks:
  - id: weekly-agents
    command: update-agents
    schedule: "0 0 * * 1"
    config:
      gist_url: https://gist.github.com/user/gist1
      pr_title: "Weekly AGENTS.md update"

  - id: monthly-cleanup
    command: cleanup
    schedule: "0 0 1 * *"
    config:
      pr_title: "Monthly cleanup"
```

---

## 📚 Полезные ссылки

- [GitHub Actions Docs](https://docs.github.com/en/actions)
- [Cron Syntax Checker](https://crontab.guru/)
- [JSON Validator](https://jsonlint.com/)
- [Z.ai Documentation](https://api.z.ai/)
- [Octokit Documentation](https://github.com/octokit/octokit.js)

---

## 💡 Советы

1. **Тестируйте вручную:** Используйте `workflow_dispatch` для тестирования перед настройкой расписания
2. **Начинайте с консервативного расписания:** Например, раз в неделю, затем увеличивайте частоту
3. **Мониторьте первые запуски:** Проверяйте логи и PR после первых запусков
4. **Используйте детальные сообщения коммитов:** Это поможет понять, что изменилось
5. **Документируйте свои задачи:** Добавьте комментарии в конфигурационный файл

---

**Готово!** 🎉 Ваша задача по обновлению AGENTS.md файлов настроена и готова к работе.
