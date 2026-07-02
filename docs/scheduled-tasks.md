# Scheduled Tasks

Zai Code Bot can run tasks on a schedule (cron) in addition to its PR-review and
`/zai` comment-command flows. The built-in `update-agents` task periodically
regenerates your `AGENTS.md` knowledge files and opens a pull request with the
changes.

This is how this very repository keeps its own `AGENTS.md` files fresh.

---

## How it works

1. A GitHub Actions `schedule` (cron) event triggers the workflow.
2. The bot loads `.zai-scheduled.yml` from your default branch.
3. Tasks whose schedule matches the event are selected (all enabled tasks run
   when triggered manually, or when no specific schedule is matched).
4. For each task, the bot executes the configured command:
   - `update-agents` fetches a command from a Gist URL, runs it against the Z.ai
     model to auto-discover and regenerate `AGENTS.md` files, then opens a PR.
5. A pull request is opened **only if at least one file changed**. If everything
   is already up to date, no PR is created.

---

## Quickstart

### 1. Add a Gist with the generation command

Create a [GitHub Gist](https://gist.github.com/) containing the command the bot
should run. For `update-agents`, the Gist content is a prompt-command such as:

```text
/init-agentsmd
This command must autonomously scan the repo and return JSON with the AGENTS.md tree.
```

Copy the **raw** URL of the Gist (`https://gist.githubusercontent.com/<you>/<id>/raw`).

### 2. Add the config file

Copy the template into your repository root:

```bash
cp .zai-scheduled.yml.template .zai-scheduled.yml
```

Then edit it (see [Configuration reference](#configuration-reference)).

### 3. Set the Gist URL

Add the raw Gist URL as a repository variable (or secret):

- **Settings -> Secrets and variables -> Actions -> Variables**
- Name: `ZAI_AGENTS_GIST_URL`, Value: your raw Gist URL

You can also set it directly in the config file (see
[Priority order](#gist_url-priority-order)).

### 4. Add a scheduled workflow

Create `.github/workflows/zai-scheduled.yml`:

```yaml
name: Zai Scheduled Tasks

on:
  schedule:
    - cron: "0 0 * * 0"   # every Sunday at 00:00 UTC
  workflow_dispatch:       # allow manual runs

permissions:
  contents: write          # required to create branches + commits
  pull-requests: write     # required to open PRs

jobs:
  zai-scheduled:
    runs-on: ubuntu-latest
    steps:
      - name: Checkout
        uses: actions/checkout@v4
        with:
          fetch-depth: 0

      - name: Run scheduled tasks
        uses: AndreiDrang/zai-code-bot@main
        with:
          ZAI_API_KEY: ${{ secrets.ZAI_API_KEY }}
          ZAI_MODEL: ${{ vars.ZAI_MODEL }}
          ZAI_SCHEDULED_ENABLED: "true"
          ZAI_AGENTS_GIST_URL: ${{ vars.ZAI_AGENTS_GIST_URL }}
```

> Note: GitHub Actions `schedule` events can be delayed or skipped during periods
> of high load. Use `workflow_dispatch` to trigger a run manually for testing.

---

## Configuration reference

All configuration lives in `.zai-scheduled.yml` at the root of your repository.

### Top-level fields

| Field | Required | Description |
|-------|----------|-------------|
| `version` | Yes | Config schema version. Must be `1`. |
| `defaults` | No | Default settings applied to every task (see below). |
| `tasks` | Yes | Array of task definitions (see below). |

### `defaults`

| Field | Default | Description |
|-------|---------|-------------|
| `branch` | `main` | Default target branch for PRs created by tasks. |
| `schedule` | `0 0 * * 0` (Sunday 00:00 UTC) | Default cron expression applied to tasks without one. |
| `gist_url` | _(empty)_ | Default Gist URL for commands. See [Priority order](#gist_url-priority-order). |
| `enabled` | `true` | Whether tasks are enabled by default. |

### Task fields

Each entry in the `tasks` array:

| Field | Required | Default | Description |
|-------|----------|---------|-------------|
| `id` | Yes | - | Unique task identifier. |
| `command` | Yes | - | Command to run. Currently `update-agents`. |
| `name` | No | `id` | Human-readable task name. |
| `enabled` | No | `defaults.enabled` | Whether this task runs. |
| `schedule` | No | `defaults.schedule` | Cron expression for this task. |
| `config` | No | merged with `defaults` | Per-task config (see below). |

### Task `config` (for `update-agents`)

| Field | Default | Description |
|-------|---------|-------------|
| `branch` | `defaults.branch` | Target branch for the PR. |
| `gist_url` | `defaults.gist_url` | Gist URL to fetch the command from. |
| `pr_title` | _(bot default)_ | Title of the created PR. |
| `pr_body` | _(bot default)_ | Body of the created PR. |
| `commit_message` | _(bot default)_ | Commit message for the changes. |

### Minimal example

```yaml
version: 1

defaults:
  branch: main
  schedule: "0 0 * * 0"   # weekly Sunday 00:00 UTC

tasks:
  - id: weekly-agents-update
    name: "Weekly AGENTS.md Update"
    enabled: true
    command: update-agents
    config:
      gist_url: https://gist.githubusercontent.com/<you>/<id>/raw
      pr_title: "chore: update AGENTS.md files"
      commit_message: "docs: update AGENTS.md from scheduled task"
```

### Full example

See `.zai-scheduled.yml.template` for a fully commented configuration including
a disabled secondary task and a ready-to-use workflow snippet.

---

## `gist_url` priority order

The Gist URL is resolved in this order (first non-empty wins):

1. `task.config.gist_url`
2. `defaults.gist_url`
3. `ZAI_AGENTS_GIST_URL` action input / environment variable

If none are set, the task fails with `Missing gist_url configuration`.

---

## Cron schedule reference

GitHub Actions uses 5-field cron in **UTC**:

```text
┌───────────── minute (0 - 59)
│ ┌───────────── hour (0 - 23)
│ │ ┌───────────── day of month (1 - 31)
│ │ │ ┌───────────── month (1 - 12 or JAN-DEC)
│ │ │ │ ┌───────────── day of week (0 - 6 or SUN-SAT)
│ │ │ │ │
* * * * *
```

| Expression | Meaning |
|------------|---------|
| `0 0 * * 0` | Every Sunday at 00:00 UTC |
| `0 0 * * 1` | Every Monday at 00:00 UTC |
| `0 0 * * *` | Every day at 00:00 UTC |
| `0 9 * * 1-5` | Weekdays at 09:00 UTC |
| `0 */6 * * *` | Every 6 hours |

> Tip: use [crontab.guru](https://crontab.guru/) to build and verify expressions.

### How schedule matching works

- When a `schedule` event fires, GitHub delivers the cron expression that
  triggered it as part of the event payload.
- A task runs if **either** is true:
  - the task's `schedule` equals the event's cron expression, **or**
  - the task's `schedule` equals `defaults.schedule`.
- In other words, tasks on the default schedule always run, and any task whose
  schedule directly matches the fired cron also runs.
- Manually-triggered runs (`workflow_dispatch`) run all enabled tasks regardless
  of their individual schedules.

---

## Action inputs

| Input | Default | Description |
|-------|---------|-------------|
| `ZAI_API_KEY` | _(required)_ | Z.ai API key. |
| `ZAI_MODEL` | `glm-5.2` | Z.ai model to use. |
| `ZAI_SCHEDULED_ENABLED` | `true` | Master switch for scheduled tasks. |
| `ZAI_SCHEDULED_CONFIG_PATH` | `.zai-scheduled.yml` | Path to the config file. |
| `ZAI_AGENTS_GIST_URL` | _(empty)_ | Fallback Gist URL (lowest priority). |

Set `ZAI_SCHEDULED_ENABLED: "false"` to disable the scheduled pipeline entirely
without removing the config file.

---

## Manual run: `/zai update-agents`

You can trigger an AGENTS.md regeneration on demand from any PR by leaving the
comment:

```text
/zai update-agents
```

This runs the same `update-agents` task ad-hoc and posts the result in-thread.
It is subject to the same collaborator authorization as other `/zai` commands.

---

## What `update-agents` does

1. Resolves the Gist URL (see [Priority order](#gist_url-priority-order)).
2. Fetches the command text from the Gist.
3. Builds an auto-discovery prompt and sends it to the Z.ai model.
4. The model returns JSON describing which `AGENTS.md` files to create or update:
   ```json
   {
     "summary": "Updated 3 AGENTS.md files",
     "files": [
       {"path": "AGENTS.md", "content": "...", "action": "updated"},
       {"path": "src/lib/AGENTS.md", "content": "...", "action": "created"}
     ]
   }
   ```
5. Each returned file is compared against its current content on the target
   branch. Only files whose content actually differs are committed.
6. If one or more files changed, a PR is opened on a branch named
   `zai-scheduled/YYYY.MM.DD_HH.MM`. If nothing changed, no PR is created.

The response parser accepts a few shapes: the `path`/`content` fields above,
plus `file` as an alias for `path`, `body` as an alias for `content`, and an
`action` of `updated`/`created` (a file with no current content is treated as
new). Non-JSON responses fall back to a single `AGENTS.md` entry containing the
raw text.

---

## Troubleshooting

**No PR is created.**
Either no files changed (everything was already up to date), or no tasks were
selected to run. Check the action logs for `skipped: no tasks` or
`prCreated: false`.

**`Missing gist_url configuration`.**
No Gist URL was resolved. Set `ZAI_AGENTS_GIST_URL`, or `gist_url` in
`defaults` or the task's `config`.

**`Failed to fetch from gist`.**
The Gist URL is invalid, private, or unreachable. Ensure you are using the
**raw** URL and that the Gist is public (or accessible to the workflow token).

**`Empty response from gist URL`.**
The Gist exists but its content is blank. Add the command text to the Gist.

**`Unsupported config version`.**
Your `.zai-scheduled.yml` has a `version` other than `1`. Regenerate it from the
latest `.zai-scheduled.yml.template`.

**`Configuration must contain a "tasks" array`.**
The `tasks` key is missing or not an array. Add at least one task entry.

**`Unknown scheduled command: <name>`.**
The `command` field references a command the bot does not know. Currently only
`update-agents` is supported.

**Scheduled runs are delayed or skipped.**
GitHub Actions does not guarantee `schedule` events run exactly on time or at
all during high load. For reliable runs, trigger manually via
`workflow_dispatch` or `/zai update-agents`.

---

## Extending: custom scheduled commands

The scheduled pipeline is extensible. Handlers are registered in a registry
(`SCHEDULED_HANDLERS` in `src/lib/handlers/scheduled.js`) and can be added
without changing the core dispatch logic. See the
[handlers guide](../src/lib/handlers/AGENTS.md) for the internal contract if you
are contributing a new task type.
