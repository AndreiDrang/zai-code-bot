# Z.ai Code Review

AI-powered GitHub Pull Request code review using Z.ai models. Automatic PR comments, bug detection, and improvement suggestions via GitHub Actions.

## Features

- 🚀 Automatic PR review on open/synchronize
- 🔍 Interactive commands (`/zai ask`, `/zai help`, `/zai review`, `/zai explain`, `/zai suggest`, `/zai compare`)
- 🧠 AI-driven PR feedback
- ⚡ Works with GitHub Actions
- 🔐 Collaborator-only command access
- 🔄 Marker-based comment updates (idempotent)

## Quickstart

Add this to your `.github/workflows/code-review.yml`:

```yaml
name: AI Code Review with Z.ai

on:
  pull_request:
    types: [opened, synchronize]

permissions:
  contents: read
  pull-requests: write

jobs:
  review:
    name: Review
    runs-on: ubuntu-latest
    steps:
      - name: Checkout
        uses: actions/checkout@v4
      - name: Code Review
        uses: tarmojussila/zai-code-review@v0.1.1
        with:
          ZAI_API_KEY: ${{ secrets.ZAI_API_KEY }}
```

## Inputs

| Input | Required | Default | Description |
|---|---|---|---|
| `ZAI_API_KEY` | Yes | — | Your Z.ai API key |
| `ZAI_MODEL` | No | `glm-4.7` | Z.ai model to use for review |

## Commands

The action responds to comments on pull requests. Use `/zai` or `@zai-bot` prefix.

| Command | Example | Description |
|---|---|---|
| `/zai ask <question>` | `/zai ask what does this function do?` | Ask questions about the PR code |
| `/zai help` | `/zai help` | Show available commands |
| `/zai review` | `/zai review src/utils.ts` | Review a specific file in the PR |
| `/zai explain <lines>` | `/zai explain 10-20` | Explain specific line numbers |
| `/zai suggest <prompt>` | `/zai suggest better variable naming` | Get improvement suggestions |
| `/zai compare` | `/zai compare` | Compare old vs new version in PR |

### Authorization

Interactive commands require collaborator access (write permission). Fork PR authors who are not collaborators receive an authorization error.

### Trigger Behavior

- **PR opened**: Creates a new review comment
- **PR synchronize**: Updates the existing review comment (marker-based idempotent)
- **Issue comment on PR**: Processes `/zai` commands if commenter is a collaborator

## Configuration

To use this action, you must add your Z.ai API key as a GitHub secret.

### 1️⃣ Get your Z.ai API key

Generate an API key from your Z.ai dashboard.

### 2️⃣ Add the API key to your repository

1. Go to your GitHub repository  
2. Click **Settings**  
3. Navigate to **Secrets and variables → Actions**  
4. Click **New repository secret**  
5. Add:

   - **Name:** `ZAI_API_KEY`  
   - **Value:** your Z.ai API key  

6. Click **Save**

## Contributing

Contributions are welcome. See the [CONTRIBUTING](CONTRIBUTING.md) file for more information.

## License

This project is licensed under the MIT License. See the [LICENSE](LICENSE) file for more information.
