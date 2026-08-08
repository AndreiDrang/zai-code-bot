# План: рефакторинг `review` + общая структура хэви-команд

> **Scope (зафиксирован):** только `review`. Инфраструктура (промпт-билд,
> контекст-билдер, `/context/` стор, раннер) строится переиспользуемой — для
> будущих волн (impact / ask / explain / describe).
>
> **Решения:**
>
> 1. `/context/` — **единственный** стор ответа (per-run артефакт убирается из review).
> 2. Промпты живут в **`zai-heavy-worker/`** (рядом с хендлерами).
> 3. Объём — **только review**; остальные хэви-команды — следующая волна.

---

## Текущее состояние (почему надо менять)

| Команда                    | Путь                 | Контекст хендлеру               | Что читает из gather                              | Где хранит ответ                                    |
| -------------------------- | -------------------- | ------------------------------- | ------------------------------------------------- | --------------------------------------------------- |
| `review`                   | **durable queue**    | `{github, env, db, job, runId}` | diff, description, files(**имена**)               | `v1/runs/{job}/{run}/response.md` (per-run, append) |
| `impact`                   | durable queue\*      | `{github, env, db, job, runId}` | KV-card + manifest (**ничего не вызывает**)       | — (стаб)                                            |
| `ask`/`explain`/`describe` | **fetch-delegation** | `{github, env, payload}`        | KV-card (**ask/explain**) / ничего (**describe**) | — (стабы)                                           |

\* `impact` зарегистрирован в `getHeavyHandler` и входит в `jobs.kind CHECK`, но
фактически ходит через service-binding (`parsed.type === 'review'` — единственный
гейт durable-маршрутизации в `index.js:187`).

**Три проблемы, которые решаем:**

1. Системный промпт — инлайн-константа `REVIEW_SYSTEM_MESSAGE` (2 предложения в
   `review.js:33`). Нет файлов, нет build-шага.
2. `review` не отправляет ЛЛМ **коммиты и комментарии** — только
   diff/description/имена файлов. Gather уже всё собирает (`pr-context.js:112-114`
   пишет files/diff/commits/description/comments), но ридер их не тянет.
3. Ответ хранится **per-run** (`v1/runs/.../response.md` + D1 `artifacts`), а не
   per-command-per-PR. Нет «latest review для этого PR».

---

## Требование 1 — Системные промпты как билдящиеся файлы

**Паттерн из референса** (`tb-news-ai-analyzer/scripts/generate-prompt.mjs`):
`src/prompts/*.txt` → `JSON.stringify` → `src/generated/*.ts`
(`export const NAME = "…"`). Потребляет `analyzer-runner.ts` импортом.

**Адаптация под zai (JS, не TS, в heavy-воркере):**

```
poc/workers/zai-heavy-worker/
  prompts/review.txt            ← авторский системный промпт (человеко-читаемый)
  scripts/generate-prompts.mjs  ← review.txt → generated/prompts.js (копия референса)
  generated/prompts.js          ← export const REVIEW_PROMPT = "…"; (коммитится)
```

`generate-prompts.mjs` — точная адаптация референсного `generate-prompt.mjs`:
массив `{file:'review.txt', constName:'REVIEW_PROMPT'}`, `fs.readFile` →
`JSON.stringify` → `fs.writeFile`. Один выходной файл `prompts.js` (всего 5
промптов в перспективе — проще, чем 5 файлов).

**Build-шаг:**

- `zai-heavy-worker/package.json`:
  `"generate:prompts": "node scripts/generate-prompts.mjs"`.
- Сгенерированный `generated/prompts.js` **коммитится** (как `dist/index.js` в
  parent-action) — `wrangler deploy` работает без prebuild. Генератор запускают
  при изменении `.txt`.
- Хендлер: `import { REVIEW_PROMPT } from '../generated/prompts.js';` →
  `{ role: 'system', content: REVIEW_PROMPT }`.
- Удалить инлайн-константу `REVIEW_SYSTEM_MESSAGE` из `review.js:33`.

---

## Требование 2 — Полный контекст ЛЛМ

Gather уже пишет 5 срезов (`pr-context.js:111-115`): `files`, `diff`, `commits`,
`description`, `comments`. Ридеры существуют (`readContextSlice`). Сейчас `review`
читает 3 из 5 и пропускает `commits` + `comments`.

**Общий модуль `shared/llm-context.js`** — чистая функция (переиспользуема для
будущих команд):

```js
buildContextBlock({ slices: {diff, commits, description, comments, files},
                    command, budgetBytes })
  → string   // компактный markdown: ## Commits, ## Description, ## Conversation, ## Diff (bounded)
```

`review` → все 5 срезов; diff = primary (львиная доля `maxContextBytes`),
commits/comments/description — вторичны с обрезкой. Заменяет текущий
`buildReviewPrompt` в `review.js:287`.

**Карта срезов по командам (для будущих волн):**

| Команда    | diff       | commits    | description  | comments | files       | Акцент                       |
| ---------- | ---------- | ---------- | ------------ | -------- | ----------- | ---------------------------- |
| `review`   | ✅ primary | ✅         | ✅           | ✅       | имена       | корректность/безопасность    |
| `impact`   | ✅         | ✅ primary | ✅           | ✅       | список      | blast-radius/риск            |
| `ask`      | ✅         | ✅         | ✅           | ✅       | —           | ответ на вопрос пользователя |
| `explain`  | ✅         | —          | —            | —        | +окно строк | объяснение диапазона         |
| `describe` | —          | ✅ primary | текущее body | —        | —           | генерация описания           |

Бюджет — `config.maxContextBytes` (уже есть, `review.js:53`). Каждый срез
получает долю бюджета; `comments`/`commits` — JSON, рендерятся в компактный
markdown с обрезкой.

---

## Требование 3 — Ответ в `/context/{command}.md` (1 команда = 1 файл, перезапись)

Новый key-builder в `shared/storage/keys.js`:

```js
// v1/prs/{repo}/{pr}/context/review.md  (поверх /context/, но ВНЕ gather-allowlist)
export function prCommandResultKey(repositoryId, prNumber, command) {
  return (
    `v${STORAGE_SCHEMA_VERSION}/prs/${component(repositoryId, "repository id")}/` +
    `${component(prNumber, "pr number")}/context/${component(command, "command")}.md`
  );
}
```

**Важно:** `command` НЕ входит в `PR_CONTEXT_KINDS` (тот — для gather-входов +
валидации manifest). Отдельный билдер → не ломает gather, не пачкает allowlist.
Пишется raw `bucket.put` (как incremental-refresh — без D1-индекса, без
manifest). Перезапись = та же ключ → overwrite.

- **Убрать** из `review.js`: `writeArtifact(...)` + `linkRunResultArtifact(...)`
  (строки ~`review.js:215-236`) + импорты. `/context/review.md` = единственный
  стор ответа.
- **Новый ридер** `readCommandResult(bucket, repoId, prNumber, command)` →
  потребитель: заметка в комментарии со ссылкой на latest-результат; будущий
  `/zai review --last`. (анти-write-only — в той же поставке).

> ⚠️ **Следствие принятого решения:** `writeArtifact`/`readArtifact` теряют
> продюсера (возвращаются к состоянию до `4d00d54`), `analysis_runs.result_artifact_id`
> остаётся nullable/неиспользуемым для review. Функции остаются в модуле на
> будущее.

---

## Требование 4 — Общая структура (scaffolding для будущих команд)

`shared/llm-command-runner.js` — lifecycle, который review использует сейчас, а
impact/ask/explain унаследуют:

```js
runLlmCommand({
  github,
  env,
  db,
  job,
  runId,
  command, // 'review' | 'impact' | …
  systemPrompt, // из generated/prompts.js
  buildUserPrompt, // (ctx) => string — использует buildContextBlock
  commentMarker, // REVIEW_MARKER | IMPACT_MARKER | …
  commentKind, // 'review' | 'impact' | …
  emoji,
}); // '🔍' | '📊' | …
```

Шаги: config → API-key (graceful degrade) → load all slices → system+user prompt
→ Z.ai → **`bucket.put(prCommandResultKey)`** → `upsertComment(marker)`.

`review.js` становится тонкой обёрткой: `systemPrompt = REVIEW_PROMPT`,
`buildUserPrompt` через `buildContextBlock`, маркер `REVIEW_MARKER`,
`command:'review'`.

---

## Файловая карта изменений

| Файл                                            | Действие                                                                                    |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------- |
| `zai-heavy-worker/prompts/review.txt`           | **NEW** — авторский промпт                                                                  |
| `zai-heavy-worker/scripts/generate-prompts.mjs` | **NEW** — билдер (копия референса)                                                          |
| `zai-heavy-worker/generated/prompts.js`         | **NEW** — сгенерённый, коммитится                                                           |
| `zai-heavy-worker/package.json`                 | + `"generate:prompts"` script                                                               |
| `shared/llm-context.js`                         | **NEW** — `buildContextBlock`                                                               |
| `shared/llm-command-runner.js`                  | **NEW** — `runLlmCommand` lifecycle                                                         |
| `shared/storage/keys.js`                        | + `prCommandResultKey`                                                                      |
| `shared/pr-context-reader.js`                   | + `readCommandResult`                                                                       |
| `zai-heavy-worker/src/handlers/review.js`       | **рефактор**: thin wrapper, убрать writeArtifact, полный контекст                           |
| `tests/`                                        | + `llm-context.test.js`, + `generate-prompts` smoke, обновить `handlers-review-llm.test.js` |

---

## Фазы исполнения

1. **Промпт-инфраструктура** — `prompts/review.txt` + `generate-prompts.mjs` +
   `generated/prompts.js` + package.json script + smoke-тест генератора.
2. **Контекст-билдер** — `shared/llm-context.js` (`buildContextBlock`, все 5
   срезов) + юнит-тесты.
3. **Стор `/context/`** — `prCommandResultKey` + `readCommandResult` + тесты.
4. **Раннер + рефактор review** — `shared/llm-command-runner.js`, `review.js` →
   thin wrapper (REVIEW_PROMPT, buildContextBlock, /context/review.md, убрать
   writeArtifact). Обновить `handlers-review-llm.test.js`.
5. **Валидация** — `vitest` + `prettier --check`; коммит.

Каждый коммит — локальный, Conventional Commits, co-author trailer
(`Co-authored-by: pi <noreply@earendil-works.com>`).

---

## Следующая волна (вне scope — задел)

- `impact`: поднять из стаба в реальный LLM → `runLlmCommand` + `IMPACT_PROMPT`
  - `buildContextBlock({command:'impact'})`.
- `ask`/`explain`/`describe`: требуют durable-пути → миграция (`payload`/
  `arguments` колонка в `jobs` + расширить `jobs.kind CHECK`). Сейчас на
  fetch-delegation и несут аргументы (вопрос/диапазон).
- Живой fallback для >300-файл PRs: `getPrDiff` в review тоже 406'ит — вынести
  `reconstructDiff` в общий `getPrDiffReconstructed`.
