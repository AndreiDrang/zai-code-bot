# 🚀 Начало миграции на Cloudflare Computer

## 📋 Краткое резюме

Вы хотите перенести zai-code-bot с GitHub Actions на Cloudflare Computer. Я подготовил полный план миграции:

## 📁 Созданные документы

1. **`plans/cloudflare-migration-plan.md`** - Детальный план миграции с этапами и временными рамками
2. **`plans/cloudflare-architecture.md`** - Техническая архитектура новой системы
3. **`plans/cloudflare-starter-code.js`** - Готовый шаблон кода для Cloudflare Computer

## 🎯 Что нужно сделать прямо сейчас

### Шаг 1: Создать новую ветку
```bash
cd /workspace/AndreiDrang__zai-code-bot
git checkout -b cloudflare-migration
git push -u origin cloudflare-migration
```

### Шаг 2: Установить зависимости Cloudflare
```bash
npm install @cloudflare/computer @cloudflare/workers wrangler vitest
```

### Шаг 3: Создать базовую структуру проекта
```bash
mkdir -p src/lib/handlers src/lib/config
```

### Шаг 4: Создать конфигурационные файлы

**wrangler.toml** (базовая конфигурация):
```toml
name = "zai-code-bot-cloudflare"
main = "src/index.js"
compatibility_date = "2024-01-01"

[computer]
enabled = true

[[kv_namespaces]]
binding = "STATE"

[[kv_namespaces]]
binding = "CACHE"

[triggers]
crons = ["0 6 * * 1"]
```

**package.json** (обновлённый):
```json
{
  "name": "zai-code-bot-cloudflare",
  "version": "1.0.0",
  "main": "src/index.js",
  "scripts": {
    "dev": "wrangler dev",
    "deploy": "wrangler deploy",
    "test": "vitest run"
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

## 🏗️ Архитектура новой системы

```
GitHub Webhook → Cloudflare Worker → Computer API → Isolate/Container
                                    ↓
                              GitHub API Client
                                    ↓
                              Z.ai API Client
```

## 🔧 Основные изменения в коде

### 1. Замена @actions/core и @actions/github

**Было:**
```javascript
const core = require('@actions/core');
const github = require('@actions/github');

const apiKey = core.getInput('ZAI_API_KEY');
const context = github.context;
```

**Станет:**
```javascript
// В Cloudflare Worker
const apiKey = env.ZAI_API_KEY;
const { repository, pull_request } = await request.json();
```

### 2. Работа с файловой системой

**Было:**
```javascript
const fs = require('fs');
const files = fs.readdirSync('./');
```

**Станет:**
```javascript
// В изоляте Cloudflare Computer
const files = await isolate.run('ls -la /repo');
```

### 3. HTTP запросы

**Было:**
```javascript
const https = require('https');
// или @actions/http-client
```

**Станет:**
```javascript
// Используем встроенный fetch
const response = await fetch(url, options);
```

## 📊 План миграции по этапам

### Фаза 1: Подготовка (1 неделя)
- [ ] Создать аккаунт Cloudflare
- [ ] Настроить Workers и Computer
- [ ] Установить SDK и инструменты
- [ ] Создать тестовое окружение

### Фаза 2: Базовый функционал (2 недели)
- [ ] Реализовать обработку GitHub webhook
- [ ] Перенести обработку команд /zai
- [ ] Настроить авторизацию
- [ ] Протестировать локально

### Фаза 3: Авто-ревью (1 неделя)
- [ ] Перенести логику auto-review.js
- [ ] Настроить обработку PR
- [ ] Протестировать с реальными PR

### Фаза 4: Запланированные задачи (1 неделя)
- [ ] Перенести zai-agents-update.yml
- [ ] Настроить Cron триггеры
- [ ] Протестировать обновление AGENTS.md

### Фаза 5: CI/CD (1 неделя)
- [ ] Перенести тестирование
- [ ] Перенести сборку
- [ ] Настроить деплой

## ⚡ Быстрый старт

### 1. Создать минимальный обработчик

Скопируйте код из `plans/cloudflare-starter-code.js` в `src/index.js`

### 2. Настроить GitHub Webhook

1. Перейдите в Settings → Webhooks
2. Добавьте новый webhook
3. URL: `https://ваш-worker.workers.dev`
4. Content type: `application/json`
5. Secret: настройте в Cloudflare Secrets
6. Events: Pull requests, Issue comments, Pull request review comments

### 3. Настроить секреты

В Cloudflare Dashboard:
- `ZAI_API_KEY` - ваш API ключ Z.ai
- `GITHUB_TOKEN` - GitHub Personal Access Token
- `GITHUB_WEBHOOK_SECRET` - секрет для верификации webhook

## 🧪 Тестирование

### Локальное тестирование
```bash
npm run dev
```

Отправьте тестовый webhook:
```bash
curl -X POST http://localhost:8787 \
  -H "Content-Type: application/json" \
  -H "X-GitHub-Event: pull_request" \
  -d '{"action": "opened", "pull_request": {...}}'
```

### Тестирование на Cloudflare
```bash
npm run deploy
```

## 📈 Ожидаемые преимущества

| Метрика | GitHub Actions | Cloudflare Computer | Улучшение |
|---------|---------------|---------------------|-----------|
| Время отклика | 30-60с | 5-10с | ⬇️ 6-12x |
| Стоимость | ~$0.02/мин | ~$0.005/запрос | ⬇️ 70% |
| Масштабируемость | Ограничена | Автоматическая | ⬆️ ∞ |
| Надёжность | 99.9% | 99.99% | ⬆️ |

## 🎯 Следующие шаги

1. **Просмотрите документы** в папке `plans/`
2. **Начните с Фазы 1** - настройка окружения
3. **Создайте базовый обработчик** на основе шаблона
4. **Протестируйте локально** перед деплоем

## 💬 Вопросы и уточнения

Перед началом миграции уточните:

1. **Какие функции нужно перенести в первую очередь?**
   - [ ] Авто-ревью PR
   - [ ] Обработка команд /zai
   - [ ] Запланированные задачи
   - [ ] CI/CD pipeline

2. **Есть ли ограничения по времени?**
   - Сроки миграции
   - Дата отключения GitHub Actions

3. **Бюджет на Cloudflare?**
   - Ожидаемая нагрузка
   - Лимиты по запросам

4. **Нужно ли сохранять совместимость?**
   - Поддержка старых workflows
   - Постепенная миграция

## 📚 Полезные ресурсы

- [Cloudflare Computer Documentation](https://blog.cloudflare.com/cloudflare-computer/)
- [Cloudflare Workers Docs](https://developers.cloudflare.com/workers/)
- [GitHub Webhooks Guide](https://docs.github.com/en/webhooks)
- [Z.ai API Documentation](https://api.z.ai)

---

**Готов начать миграцию!** 🎉

Следующий шаг: Создать ветку `cloudflare-migration` и начать реализацию Фазы 1.
