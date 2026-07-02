# AGENTS.md

## Repository overview

`zai-code-bot` is a Telegram bot that proxies user prompts to Zalo AI (ZAI)
for code generation and assistance. It is a small, single-project Python
service: bot handlers call into the ZAI client, format responses, and send
them back to Telegram chats.

This is not a library and not a monorepo. Treat the whole repository as one
runnable application.

## Where to work

```text
.
├── main.py            # Bot entrypoint — polling/webhook bootstrap, registers handlers
├── config.py          # Reads env vars (tokens, model ids, timeouts); central settings
├── requirements.txt   # Python dependencies (pin versions when touching)
├── .env.example        # Template for required env vars — keep in sync with config.py
├── handlers/          # Telegram message/command handlers, grouped by feature
├── services/          # ZAI client wrappers, prompt building, response formatting
├── keyboards/         # Inline/reply keyboards (if present)
├── utils/             # Small helpers: logging, text splitting, rate limits
└── README.md          # User-facing setup and run instructions
```

If a path above does not exist in this checkout, prefer the closest
matching module rather than inventing new top-level folders.

## Architecture and boundaries

- **Bot layer** (`handlers/`, `main.py`): owns Telegram I/O only — receive
  updates, parse commands, call a service, render the result. Do not call
  the ZAI HTTP API directly from handlers.
- **Service layer** (`services/`): owns ZAI interaction — prompt assembly,
  model invocation, response normalization, error mapping. Do not import
  `telebot`/bot framework types here; accept and return plain Python data.
- **Config layer** (`config.py`): single source of truth for secrets and
  tunables. Read env vars here, not scattered across modules.

Keep the Telegram side and the ZAI side separable. A change to ZAI response
shape should require edits in `services/`, not in `handlers/`.

## Change rules

- Do not hard-code tokens, cookies, or user keys. Always go through
  `config.py` and `.env`.
- When changing the request payload to ZAI, update the corresponding
  parser in the same service module in the same change.
- Preserve message-splitting behavior in `utils/`: Telegram has a 4096-char
  limit per message; do not send unbounded responses.
- Preserve `parse_mode` consistency. If a handler sends Markdown/HTML, the
  service-layer text must already be escaped accordingly.
- Avoid blocking calls inside handlers — the bot framework processes updates
  sequentially or in a limited pool. Long ZAI calls should not be wrapped
  in additional synchronous sleeps.
- Do not introduce a database or persistent store without checking whether
  one already exists; this bot is intended to be mostly stateless.

## Validation

Exact commands depend on what is installed locally. Conservative options:

- Syntax/type check: `python -m compileall .` (always safe) or `pyright`/
  `mypy` if configured.
- Dependency install: `pip install -r requirements.txt`.
- Local run: run the entrypoint referenced in `README.md` (typically
  `python main.py`), after exporting the variables from `.env.example`.
- There is no committed test suite visible; do not invent test commands. If
  you add tests, place them under a `tests/` directory and document the runner.

If `README.md` specifies different run/lint commands, prefer those.

## Key docs

- `README.md` — setup, required env vars, and how to run the bot.
- `.env.example` — authoritative list of expected environment variables.
- `requirements.txt` — pinned runtime dependencies.

Read `README.md` before changing setup, env vars, or deployment assumptions.

## Repository-specific gotchas

- **Secrets**: Telegram bot token and ZAI credentials are read from the
  environment. Never log full prompts, full responses, tokens, or cookies.
  When adding logs, redact by default.
- **ZAI session/cookie drift**: Zalo AI endpoints can change auth shape or
  rate-limit behavior. If responses start failing across the board, suspect
  the service-layer client before suspecting handlers.
- **Markdown escaping**: ZAI responses often contain backticks, asterisks,
  and underscores. Sending them raw with `parse_mode='MarkdownV2'` will
  break delivery. Confirm the existing escaping path before editing it.
- **Message length**: code answers can exceed Telegram's 4096-char cap.
  Always route long text through the existing splitter; do not assume
  single-message replies.
- **Concurrency**: confirm the bot's polling/worker model before adding
  background tasks. Adding threads/async without alignment can reorder or
  drop updates.
- **No live network in CI by default**: do not write validation steps that
  require hitting the real ZAI endpoint or Telegram API.
