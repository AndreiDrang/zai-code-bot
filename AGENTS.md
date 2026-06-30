# AGENTS.md

## Repository overview

`zai-code-bot` is a Python-based code assistant bot powered by ZhipuAI (GLM) models. It provides chat, code generation, code review, and repository-aware assistance through a bot interface.

## Where to work

```text
.
├── src/                  # Application source code (bot logic, handlers, tools)
├── tests/                # Unit and integration tests
├── docs/                 # Project documentation
├── examples/             # Usage examples and sample scripts
├── config/               # Configuration templates and settings
└── scripts/              # Utility and deployment scripts
```

## Architecture and boundaries

- **Bot layer**: Handles incoming messages, commands, and session management. Do not mix API-calling logic directly into message handlers.
- **LLM integration**: All ZhipuAI API calls go through a dedicated client/service module. Never instantiate raw API clients in handlers.
- **Tool/function-calling**: Code tools (analysis, generation, review) are registered separately and invoked via the model's function-calling capability.
- **Configuration**: Runtime configuration is loaded from environment variables or config files. Do not hardcode API keys, model names, or endpoints.
- **Session/context management**: Conversation context and token budgeting are managed centrally. Keep context-window logic in its dedicated module.

## Change rules

- Keep the bot handler layer thin; push logic into service modules.
- When adding a new tool or capability, register it in the tool registry — do not inline it into the conversation flow.
- Preserve the separation between prompt construction and API invocation.
- Any new external API integration must go through the existing client abstraction.
- Configuration changes must not introduce hardcoded secrets.
- When modifying response formatting, test against the model output schema expected by the bot interface.

## Validation

- **Run tests**: `pytest` (or `python -m pytest`) from the repository root.
- **Type checking**: If `mypy` or `pyright` is configured, run it before submitting changes.
- **Linting/formatting**: If `ruff`, `black`, or `flake8` configuration is present, run it.
- Verify any new tools or handlers have corresponding test coverage in `tests/`.
- If API integration changes are made, manually verify against the ZhipuAI API response format.

## Key docs

- `README.md` — Setup instructions, features, and usage overview.
- `docs/` — Additional architecture and usage documentation.
- `requirements.txt` / `pyproject.toml` — Dependency manifest; update when adding new packages.

## Repository-specific gotchas

- **API key handling**: ZhipuAI API keys must come from environment variables. Never commit keys or `.env` files.
- **Model versioning**: Model names (e.g., `glm-4`, code-specific variants) may change. Centralize model name references rather than scattering them.
- **Token limits**: GLM models have context window constraints. Any changes to conversation history or context assembly must respect token budgeting.
- **Function-calling format**: The ZhipuAI function-calling schema differs slightly from OpenAI's. Verify argument serialization matches what the API expects.
- **Rate limiting**: API calls are rate-limited. Do not introduce tight loops that call the API without backoff.
- **Async patterns**: If the bot uses async I/O, ensure new code follows the existing async conventions — do not mix blocking calls into async paths.
