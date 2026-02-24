# Zai Code Bot

GitHub Action for automatic PR reviews and context-rich `/zai` commands powered by Z.ai models.

## Features

- Automatic pull request review on `opened` and `synchronize`
- Interactive PR commands: `/zai ask`, `/zai review`, `/zai explain`, `/zai suggest`, `/zai compare`, `/zai help`
- Context-aware command prompts with full-file, diff, and thread context
- Inline review-comment support (`pull_request_review_comment`) with file/line anchors
- `/zai explain` auto-detects selected line range from review comments
- Large-file token protection using scoped windows/enclosing blocks instead of full-file dumps
- Prefix normalization: use either `/zai ...` or `@zai-bot ...`
- Threaded command replies with progress feedback and lifecycle reactions
- Marker-based idempotent comments to avoid duplicate review spam
- Fork-aware authorization with fork-PR creator command allowance

## Quickstart

Create `.github/workflows/code-review.yml`:

```yaml
name: Zai Code Bot

on:
  pull_request:
    types: [opened, synchronize, reopened, ready_for_review]
  issue_comment:
    types: [created]
  pull_request_review_comment:
    types: [created]

permissions:
  contents: read
  pull-requests: write
  issues: write

jobs:
  review:
    runs-on: ubuntu-latest
    if: github.event_name == 'pull_request' || (github.event_name == 'issue_comment' && github.event.issue.pull_request) || github.event_name == 'pull_request_review_comment'
    steps:
      - name: Checkout
        uses: actions/checkout@v4

      - name: Run Zai Code Bot
        uses: AndreiDrang/zai-code-bot@v0.0.1
        with:
          ZAI_API_KEY: ${{ secrets.ZAI_API_KEY }}
          ZAI_MODEL: ${{ vars.ZAI_MODEL }}
```

## Inputs

| Input | Required | Default | Description |
|---|---|---|---|
| `ZAI_API_KEY` | Yes | - | Z.ai API key |
| `ZAI_MODEL` | No | `glm-5` | Z.ai model for review and commands |
| `GITHUB_TOKEN` | No | `${{ github.token }}` | Token used for GitHub API calls |

## Commands

Commands are processed from PR issue comments and PR review comments. Supported prefixes: `/zai` and `@zai-bot`.

| Command | Example | Description |
|---|---|---|
| `/zai ask <question>` | `/zai ask what changed in auth flow?` | Ask about current PR changes |
| `/zai review <path>` | `/zai review src/lib/auth.js` | Review one changed file |
| `/zai explain <start-end>` | `/zai explain 10-25` | Explain a line range in selected file context |
| `/zai suggest <prompt>` | `/zai suggest propose safer error handling` | Request targeted improvement ideas |
| `/zai compare` | `/zai compare` | Compare old vs new behavior across diff |
| `/zai help` | `/zai help` | Show command help |

## Behavior

- PR auto-review comments are idempotent and updated via hidden markers
- Command replies are posted in-thread to the invoking comment
- Reactions indicate status (`eyes`, `thinking`, `rocket`, `x`)
- `/zai explain` can infer the target range from a selected line review comment when no explicit range is provided
- `/zai suggest` uses anchor path/line context from review comments when available
- `/zai compare` and `/zai review` use base/head or full-file context, not patch-only prompts
- Command execution is authorization-gated; fork PR authors can run commands on their own PR

## Setup

1. Generate a Z.ai API key from your Z.ai account.
2. In GitHub repository settings, add `ZAI_API_KEY` to **Secrets and variables -> Actions**.
3. (Optional) Add repository variable `ZAI_MODEL` to override the default model.

## Contributing

Contributions are welcome. See `CONTRIBUTING.md`.

## License

This project is licensed under MIT. See `LICENSE`.
