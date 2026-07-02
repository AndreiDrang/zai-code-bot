# Zai Code Bot

[![codecov](https://codecov.io/gh/AndreiDrang/zai-code-bot/graph/badge.svg?token=OZYcalMMXv)](https://codecov.io/gh/AndreiDrang/zai-code-bot)

GitHub Action for automatic PR reviews and context-rich `/zai` commands powered by Z.ai models.

## Features

- Automatic pull request review on `opened` and `synchronize`
- Interactive PR commands: `/zai ask`, `/zai review`, `/zai explain`, `/zai describe`, `/zai impact`, `/zai update-agents`, `/zai help`
- Scheduled tasks (cron): periodically regenerate `AGENTS.md` files and open PRs (see [Scheduled Tasks](docs/scheduled-tasks.md))
- Context-aware command prompts with full-file, diff, and thread context
- Inline review-comment support (`pull_request_review_comment`) with file/line anchors
- `/zai explain` auto-detects selected line range from review comments
- Large-file token protection using scoped windows/enclosing blocks instead of full-file dumps
- Large-PR auto-review batching with final synthesis for PRs that exceed single-request context limits
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
        uses: AndreiDrang/zai-code-bot@v0.0.6
        with:
          ZAI_API_KEY: ${{ secrets.ZAI_API_KEY }}
          ZAI_MODEL: ${{ vars.ZAI_MODEL }}
          GITHUB_TOKEN: ${{ github.token }}
```

## Inputs

| Input | Required | Default | Description |
|---|---|---|---|
| `ZAI_API_KEY` | Yes | - | Z.ai API key |
| `ZAI_MODEL` | No | `glm-5.2` | Z.ai model for review and commands |
| `GITHUB_TOKEN` | No | `${{ github.token }}` | Token used for GitHub API calls |
| `ZAI_TIMEOUT` | No | `30000` | Z.ai API request timeout in milliseconds |
| `ZAI_AUTO_REVIEW_LARGE_PR_FILE_THRESHOLD` | No | `50` | Patchable file count that switches PR auto-review into batched mode |
| `ZAI_AUTO_REVIEW_MAX_BATCH_CHARS` | No | `120000` | Approximate character budget per batched PR auto-review request |
| `ZAI_AUTO_REVIEW_MAX_FILES_PER_BATCH` | No | `40` | Maximum distinct files included in each batched PR auto-review request |
| `ZAI_AUTO_REVIEW_MAX_PATCH_CHARS` | No | `18000` | Maximum diff characters per file chunk before a large patch is split across review parts |
| `ZAI_SCHEDULED_ENABLED` | No | `true` | Master switch for the scheduled-tasks pipeline |
| `ZAI_SCHEDULED_CONFIG_PATH` | No | `.zai-scheduled.yml` | Path to the scheduled-tasks config file |
| `ZAI_AGENTS_GIST_URL` | No | - | Fallback Gist URL for the `update-agents` task (lowest priority) |

## Commands

Commands are processed from PR issue comments and PR review comments. Supported prefixes: `/zai` and `@zai-bot`.

| Command | Usage | Description |
|---------|-------|-------------|
| `/zai ask` | `/zai ask <question>` | Ask a question about the code changes in this PR |
| `/zai review` | `/zai review [file]` | Review specific files or all changed files |
| `/zai explain` | `/zai explain <lines>` | Explain selected lines (e.g., `/zai explain 10-25`) |
| `/zai describe` | `/zai describe` | Generate a PR description from commit messages |
| `/zai impact` | `/zai impact` | Analyze potential impact of changes |
| `/zai update-agents` | `/zai update-agents` | Regenerate `AGENTS.md` files on demand (same as the scheduled task) |
| `/zai help` | `/zai help` | Show command help |

**Note:** Only collaborators (and PR authors on their own fork PRs) can use these commands.

## Behavior

- PR auto-review comments are idempotent and updated via hidden markers
- Large PRs are reviewed in multiple batches and then synthesized into one final review comment
- Command replies are posted in-thread to the invoking comment
- Reactions indicate status (`eyes`, `thinking`, `rocket`, `x`)
- `/zai explain` can infer the target range from a selected line review comment when no explicit range is provided
- `/zai review` uses base/head or full-file context, not patch-only prompts
- Command execution is authorization-gated; fork PR authors can run commands on their own PR
- If GitHub's changed-files API limit is reached, the final review notes that coverage is incomplete beyond the platform ceiling

## Scheduled Tasks

In addition to PR review and `/zai` commands, Zai Code Bot can run tasks on a
schedule. The built-in `update-agents` task periodically regenerates your
`AGENTS.md` knowledge files and opens a pull request with the changes — a PR is
created only when at least one file actually changed.

### Minimal setup

1. Add a `.zai-scheduled.yml` to your repo root (copy `.zai-scheduled.yml.template`).
2. Put the generation command in a public Gist and expose its raw URL via the
   `ZAI_AGENTS_GIST_URL` action input (or `gist_url` in the config).
3. Add a `schedule` (cron) workflow that runs the action. A ready-to-use
   workflow snippet is included in `.zai-scheduled.yml.template`.

### `gist_url` priority

The Gist URL is resolved first-non-empty-wins:
`task.config.gist_url` > `defaults.gist_url` > `ZAI_AGENTS_GIST_URL`.

### Manual run

Trigger an AGENTS.md regeneration on any PR with:

```
/zai update-agents
```

For the full configuration reference, cron syntax, schedule-matching behavior,
troubleshooting, and examples, see **[docs/scheduled-tasks.md](docs/scheduled-tasks.md)**.

## Setup

1. Generate a Z.ai API key from your Z.ai account.
2. In GitHub repository settings, add `ZAI_API_KEY` to **Secrets and variables -> Actions**.
3. (Optional) Add repository variable `ZAI_MODEL` to override the default model.

## Contributing

Contributions are welcome. See `CONTRIBUTING.md`.

## License

This project is licensed under MIT. See `LICENSE`.
