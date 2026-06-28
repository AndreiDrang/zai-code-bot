# AGENTS.md

## Repository overview

`zai-code-bot` is a Telegram bot that provides access to Z.AI (Zhipu AI) LLM models, including GLM-4.6, GLM-4.5, GLM-4.5-Air, Coder models, and embedding models. It supports text chats, document analysis, voice messages (STT), image generation/editing, OCR, code execution in Docker sandboxes, admin broadcasting, referral system, token-limited free tiers, and per-user monthly token limits. Written in Python using `python-telegram-bot`.

## Where to work

```text
bot/                 # All application source (telegram handlers, llm wrappers, db models)
├── main.py          # Application entrypoint (asyncio main loop)
├── config.py        # Env-based config (singleton Config instance)
├── database.py      # SQLite engine, session factory, Base, init_db()
├── models.py        # SQLAlchemy ORM models (User, Message, Image, Settings, etc.)
├── handlers/        # Telegram update handlers grouped by feature
├── llm/             # Z.AI API client wrappers and token accounting
├── services/        # Business logic services (payments, referrals, docker, etc.)
├── utils/           # Shared helpers (logging, formatting, menus)
├── admin.py         # Admin-only commands and broadcast flow
├── stats.py         # Usage statistics aggregation
├── keyboards.py     # Inline/Reply keyboard builders
├── localization.py  # i18n string lookup (Russian primary)
└── scheduler.py     # APScheduler jobs (token resets, cleanup)
locale/              # JSON translation files (ru.json, en.json)
scripts/             # Helper shell/python scripts
alembic/             # Database migrations (versions/)
migrations/          # SQL migration scripts
Dockerfile           # Image for bot + sandbox code execution
docker-compose.yml   # Bot, postgres (optional), sandbox runtime
```

## Architecture and boundaries

- **Single long-running asyncio process** launched from `bot/main.py`. Do not introduce blocking calls in handler paths.
- **Persistence**: SQLAlchemy ORM against SQLite (default) or PostgreSQL. All schema changes go through `alembic/` migrations and `bot/models.py` together.
- **LLM access layer** is `bot/llm/`. Anything calling the Z.AI API must go through these wrappers so token accounting and error handling stay consistent.
- **Handlers** (`bot/handlers/`) register Telegram routers and must stay thin; business rules belong in `bot/services/`.
- **Admin features** (`bot/admin.py`) are gated by the `is_admin` config check; keep that gating intact on any new admin command.
- **Code execution** runs inside an isolated Docker sandbox (see `Dockerfile` and `bot/services/` sandbox code). Do not execute user-supplied code outside the sandbox.
- **Localization** is JSON-driven via `bot/localization.py` and `locale/*.json`; Russian (`ru`) is the source locale.

## Change rules

- Keep handlers thin: parse input in `bot/handlers/`, delegate logic to `bot/services/`, call models through `bot/models.py`.
- Never call the Z.AI HTTP API directly from handlers — go through `bot/llm/`.
- Any new ORM column or table requires both a new Alembic revision in `alembic/versions/` and an update to `bot/models.py`. Do not hand-edit the SQLite schema.
- Preserve existing config keys in `bot/config.py`; adding new env vars must keep backward-compatible defaults.
- When touching admin or payment/referral code, preserve the existing authorization checks exactly.
- Voice, OCR, and image pipelines have external API quotas — do not add unbounded retries.
- Keep Russian strings as the canonical locale and add English (`locale/en.json`) alongside any new keys.

## Validation

Exact validation commands are not documented in the repository. Conservatively, use:

- `python -m py_compile bot/main.py` and other modules to catch syntax errors.
- `python -c "import bot.main"` style import smoke tests after structural changes.
- Run any available scripts under `scripts/` if they match the change being made.
- If dependencies are installed from `requirements.txt`, run `alembic upgrade head` against a throwaway DB before merging model changes.

No formal test suite is present in the repo; if adding tests, place them in a `tests/` directory and mirror the `bot/` package layout.

## Key docs

- `README.md` — project overview, features, setup, and Russian/English notes.
- `alembic.ini` — Alembic migration configuration.
- `requirements.txt` — Python dependencies.
- `docker-compose.yml` — runtime service composition.
- `Dockerfile` — container build including code-sandbox runtime.

## Repository-specific gotchas

- Config is loaded from environment variables at startup via `bot/config.py`; missing required vars will fail late at first use, not at boot. Check `Config` fields when debugging.
- Token limits and free-tier accounting are enforced per-user per-month; changes to `bot/services/` billing logic must respect resets scheduled in `bot/scheduler.py`.
- The bot stores media (images, documents) references in `bot/models.py`; file paths/IDs are Telegram-native, not local filesystem paths.
- Russian is the primary UI language; do not assume English fallbacks exist for every key.
- Admin identifiers come from config — never hardcode admin Telegram IDs.
- Scheduler jobs assume the asyncio event loop is running; do not start blocking work from `bot/scheduler.py`.
