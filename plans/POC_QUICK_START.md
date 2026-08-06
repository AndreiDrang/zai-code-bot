# 🚀 Quick Start: Proof-of-Concept для /zai help

## 📋 Краткое описание

Это **минимальный guide** для быстрого запуска Proof-of-Concept переноса команды `/zai help` на Cloudflare Computer.

**Цель:** За 1-2 дня запустить работающий прототип

---

## ⚡ Шаг 1: Подготовка (30 минут)

### 1.1 Создать Cloudflare аккаунт и проект
```bash
# Установить Wrangler CLI
npm install -g wrangler

# Авторизоваться в Cloudflare
wrangler login

# Создать новый Workers проект
wrangler init zai-code-bot-poc
cd zai-code-bot-poc
```

### 1.2 Настроить GitHub

1. **Создать Personal Access Token:**
   - Settings → Developer settings → Personal access tokens → Tokens (classic)
   - Scope: `repo`, `read:org`
   - Название: `zai-code-bot-poc`
   - **Сохранить токен!** (показать только один раз)

2. **Создать тестовый репозиторий** (или использовать существующий)

---

## ⚡ Шаг 2: Копирование кода (15 минут)

### 2.1 Скопировать файлы из плана

Скопируйте эти файлы из `/plans/cloudflare-starter-code.js` и адаптируйте:

```
zai-code-bot-poc/
├── src/
│   ├── index.js              # Основной Worker
│   ├── lib/
│   │   ├── github.js         # GitHub API клиент
│   │   ├── commands.js       # Парсинг команд
│   │   ├── handlers/
│   │   │   └── help.js       # Обработчик /zai help
│   │   └── logging.js        # Логирование
│   └── config/
│       └── constants.js      # Константы
├── wrangler.toml
├── package.json
└── .dev.vars                 # Локальные переменные
```

### 2.2 Упрощённая версия для POC

**`src/index.js`** (минимальная):
```javascript
import { GitHubClient } from './lib/github.js';
import { parseCommand, formatHelp } from './lib/commands.js';

const GITHUB_TOKEN = 'GITHUB_TOKEN';
const GITHUB_WEBHOOK_SECRET = 'GITHUB_WEBHOOK_SECRET';

export default {
  async fetch(request, env, ctx) {
    // Только POST запросы
    if (request.method !== 'POST') {
      return new Response('Method Not Allowed', { status: 405 });
    }
    
    // Проверяем подпись
    const isValid = await GitHubClient.verifyWebhookSignature(
      request,
      env[GITHUB_WEBHOOK_SECRET]
    );
    
    if (!isValid) {
      return new Response('Unauthorized', { status: 401 });
    }
    
    // Парсим payload
    const payload = await request.json();
    const event = request.headers.get('x-github-event');
    
    // Обрабатываем только комментарии
    if (event !== 'issue_comment') {
      return new Response('OK', { status: 200 });
    }
    
    // Парсим команду
    const command = parseCommand(payload.comment?.body);
    
    if (!command || command.type !== 'help') {
      return new Response('Not a help command', { status: 200 });
    }
    
    // Публикуем ответ
    const github = new GitHubClient(env[GITHUB_TOKEN]);
    await github.postComment(
      payload.repository.owner.login,
      payload.repository.name,
      payload.issue.number,
      formatHelp()
    );
    
    return new Response('OK', { status: 200 });
  }
};
```

---

## ⚡ Шаг 3: Настройка (15 минут)

### 3.1 Настройка wrangler.toml
```toml
name = "zai-code-bot-poc"
main = "src/index.js"
compatibility_date = "2024-01-01"

[vars]
NODE_ENV = "development"
```

### 3.2 Настройка package.json
```json
{
  "name": "zai-code-bot-poc",
  "main": "src/index.js",
  "scripts": {
    "dev": "wrangler dev",
    "deploy": "wrangler deploy"
  },
  "dependencies": {
    "@cloudflare/workers": "^4.0.0"
  },
  "devDependencies": {
    "wrangler": "^3.0.0"
  }
}
```

### 3.3 Установка зависимостей
```bash
npm install
```

---

## ⚡ Шаг 4: Локальное тестирование (30 минут)

### 4.1 Запуск локального сервера
```bash
npm run dev
```

### 4.2 Тестирование с curl

**Создать тестовый payload:** `test-payload.json`
```json
{
  "action": "created",
  "issue": {
    "number": 123
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
    "name": "test-repo"
  }
}
```

**Отправить тестовый запрос:**
```bash
# Сгенерировать подпись (используйте ваш реальный secret)
echo -n '{"action":"created",...}' | openssl dgst -sha256 -hmac "your-secret" | awk '{print $2}'

# Отправить запрос
curl -X POST http://localhost:8787 \
  -H "Content-Type: application/json" \
  -H "X-GitHub-Event: issue_comment" \
  -H "X-Hub-Signature-256: sha256=..." \
  -d @test-payload.json
```

### 4.3 Проверка
- Должен вернуть `OK` с кодом 200
- В логах должно быть видно обработку

---

## ⚡ Шаг 5: Деплой на Cloudflare (15 минут)

### 5.1 Сохранить секреты
```bash
# Сохранить GitHub Token
wrangler secret put GITHUB_TOKEN
# Ввести токен при запросе

# Сохранить Webhook Secret
wrangler secret put GITHUB_WEBHOOK_SECRET
# Ввести secret при запросе
```

### 5.2 Деплой
```bash
npm run deploy
```

### 5.3 Настройка GitHub Webhook

1. Перейдите в репозиторий → Settings → Webhooks
2. **Add webhook**
3. **Payload URL:** `https://zai-code-bot-poc.<your-account>.workers.dev`
4. **Content type:** `application/json`
5. **Secret:** тот же, что и в `GITHUB_WEBHOOK_SECRET`
6. **Events:** `Issue comments`
7. **Active:** ✅

---

## ⚡ Шаг 6: Тестирование в продакшне (10 минут)

### 6.1 Создать тестовый issue
1. Перейдите в тестовый репозиторий
2. Создайте новый issue
3. Напишите комментарий: `/zai help`

### 6.2 Проверить результат
- Бот должен ответить с сообщением помощи
- В Cloudflare Dashboard → Workers → Logs можно увидеть логи

### 6.3 Просмотреть логи
```bash
npm run tail
```

---

## 📊 Измерение производительности

### Метрики для сбора

| Метрика | Как измерить | Цель |
|---------|--------------|------|
| Время отклика | Cloudflare Analytics | < 5с |
| Стоимость | Cloudflare Billing | Измерить |
| Успешность | Логи | 100% |

### Где смотреть

1. **Cloudflare Dashboard** → Workers → Analytics
2. **Cloudflare Dashboard** → Workers → Logs
3. **GitHub** → Issue с комментарием

---

## 🎯 Критерии успеха

### ✅ Минимальные требования
- [ ] Worker развёрнут и работает
- [ ] Webhook принимается
- [ ] Команда `/zai help` обрабатывается
- [ ] Ответ публикуется в GitHub

### 🎉 Дополнительные
- [ ] Время отклика < 5 секунд
- [ ] Стоимость измерена
- [ ] Логи пишутся

---

## 🚨 Troubleshooting

### Проблема: Webhook не проходит
**Решение:**
1. Проверьте подпись: `X-Hub-Signature-256`
2. Проверьте secret в Cloudflare
3. Проверьте, что webhook активен

### Проблема: Бот не отвечает
**Решение:**
1. Проверьте логи: `npm run tail`
2. Проверьте, что токен GitHub валиден
3. Проверьте, что у бота есть доступ к репозиторию

### Проблема: Ошибка авторизации
**Решение:**
1. Проверьте scope токена: должен быть `repo`
2. Проверьте, что пользователь имеет доступ к репозиторию

---

## 📚 Полезные команды

```bash
# Запуск локального сервера
npm run dev

# Деплой
npm run deploy

# Просмотр логов
npm run tail

# Проверка статуса
wrangler whoami

# Просмотр переменных
wrangler var list

# Просмотр секретов
wrangler secret list
```

---

## 🎉 Готово!

Вы только что запустили **Proof-of-Concept** для zai-code-bot на Cloudflare Computer! 🎉

### Следующие шаги

1. **Измерить производительность** (время отклика, стоимость)
2. **Сравнить с GitHub Actions**
3. **Документировать результаты**
4. **Решить, переносить ли остальные команды**

---

## 📖 Полная документация

Для детального плана смотрите: [`plans/POC_HELP_COMMAND.md`](./POC_HELP_COMMAND.md)

Там вы найдёте:
- Полную архитектуру
- Детальный план на 10 дней
- Шаблоны кода для всех компонентов
- Стратегию тестирования
- Критерии успеха
