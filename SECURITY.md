# Security Policy

## Overview

This document outlines the security model, authorization policies, and permission requirements for the Z.ai Code Review GitHub Action.

## Authorization Policy

### Collaborator-Only Command Execution

All `/zai` commands are **restricted to repository collaborators** with write access:

| Command | Access Level |
|---------|--------------|
| `/zai help` | Collaborator only |
| `/zai ask` | Collaborator only |
| `/zai review` | Collaborator only |
| `/zai explain` | Collaborator only |
| `/zai suggest` | Collaborator only |
| `/zai compare` | Collaborator only |

**Rationale:** Preventing unauthorized users from invoking AI-powered commands mitigates:
- Abuse of API quotas
- Potential injection of malicious prompts
- Unintended information disclosure

### Default Behavior

- **Auto-review on PR open/sync**: This passive review runs automatically for all PRs as it only reads diff content and posts a non-interactive review. No command execution is involved.
- **Interactive commands**: All `/zai` prefix commands require collaborator authentication via GitHub's permission system.

## Fork PR Handling

### Policy

PRs originating from forks (**fork PRs**) present unique security considerations because:

1. The fork author may not be a collaborator
2. The base repository owner has limited visibility into fork actions
3. Malicious actors could attempt to extract sensitive information via bot interactions

### Rules

| Scenario | Behavior |
|----------|----------|
| Fork PR comment by non-collaborator | Block all `/zai` commands silently |
| Fork PR comment by collaborator | Allow `/zai` commands (collaborator status takes precedence) |
| Fork PR auto-review (opened/synchronized) | Allow (read-only diff analysis) |
| External `/zai` command attempt | Respond with generic "unauthorized" message |

### Implementation

The action must verify:
1. `github.event.pull_request.head.repo.fork` — detects fork origin
2. Comment author's permission level via `github.rest.teams.checkPermissionsForUser` or `github.rest.repos.getCollaboratorPermission`

## Command Execution Boundaries

### Whitelist-Only Commands

The bot supports a **finite, safe command set** only:

```
/zai help      - Display available commands
/zai ask       - Answer questions about code
/zai review    - Review specific files
/zai explain   - Explain code sections
/zai suggest   - Suggest improvements
/zai compare   - Compare old vs new versions
```

### Explicitly Prohibited Operations

The following are **never executed**, regardless of user input:

- Shell or terminal command execution
- File system operations beyond reading PR diff
- Environment variable exposure or modification
- API key or secret retrieval/changes
- Repository content modification (except comments)
- Webhook or workflow trigger manipulation
- SQL or database operations
- Network calls to external services (except Z.ai API)

### Safe Response for Unauthorized Commands

When a user attempts an unknown or disallowed command:

```
🤖 I'm sorry, I can only execute authorized commands.
   See /zai help for available commands.
```

**Never expose:**
- Internal error details
- Stack traces
- API keys or tokens
- Internal function names or paths

## Permission Matrix

### Required GitHub Token Scopes

| Operation | Minimum Scope | Justification |
|-----------|---------------|---------------|
| Read PR diff | `contents: read` | Fetch changed files for analysis |
| Read PR metadata | `pull-requests: read` | Access PR number, title, description |
| Post review comment | `pull-requests: write` | Create/update PR comments |
| React to comments | `pull-requests: write` | Emoji acknowledgment |
| List collaborators | `pull-requests: read` | Verify authorization |
| Check user permissions | `members: read` (if org) | Validate collaborator status |

### Workflow Permissions Example

```yaml
permissions:
  contents: read
  pull-requests: write
  # Optional: if checking org membership
  # members: read
```

### Token Security

- **Never log or expose tokens** — Use `core.setSecret()` for any sensitive values
- **Use GitHub-provided token** — Default `github.token` has appropriate scopes
- **Rotate regularly** — If using a personal access token, rotate per organization policy

## Rate Limiting

To prevent abuse and protect API quotas:

| Limit Type | Threshold | Window |
|------------|-----------|--------|
| Per-user commands | 10 | 1 hour |
| Per-PR commands | 30 | 1 hour |
| Per-PR auto-reviews | 10 | 1 hour |

### Enforcement

- Track command invocations in action logs (not persisted across runs)
- When limit exceeded:

```
🤖 Rate limit exceeded. Please try again later.
   Limit: 10 commands per hour per user.
```

## Error Visibility

### Sanitization Rules

All user-facing error messages must be sanitized:

| Sensitive Data | Action |
|----------------|--------|
| API keys/tokens | Mask or redact completely |
| Internal paths | Replace with generic paths |
| Stack traces | Never expose to users |
| HTTP response bodies | Sanitize before logging |
| Environment variables | Never expose |

### Safe Error Messages

| Scenario | Safe Response |
|----------|---------------|
| Z.ai API failure | "Unable to complete review. Please try again." |
| Permission denied | "You are not authorized to use this command." |
| Rate limit exceeded | "Rate limit reached. Please try again later." |
| Invalid command | "Unknown command. Use /zai help for available commands." |
| Network error | "Connection error. Please verify network access." |

### Logging

Action logs (visible to repository admins only) may contain:
- Full error details for debugging
- API response metadata (without secrets)
- Command invocations with user IDs

Logs are **never visible to PR authors** unless explicitly shared by a maintainer.

## Reporting Security Issues

If you discover a security vulnerability in this action, please:

1. **Do not open a public issue**
2. Email the maintainer directly or use GitHub's private vulnerability reporting
3. Provide details: affected version, reproduction steps, potential impact

## Security Model Summary

```
┌─────────────────────────────────────────────────────────────┐
│                     Incoming Request                        │
└─────────────────────────┬───────────────────────────────────┘
                          │
                          ▼
┌─────────────────────────────────────────────────────────────┐
│  1. Detect: Fork PR? Non-collaborator?                     │
│     → If fork + non-collaborator: BLOCK                     │
└─────────────────────────┬───────────────────────────────────┘
                          │
                          ▼
┌─────────────────────────────────────────────────────────────┐
│  2. Authenticate: Is user a collaborator?                    │
│     → If no: BLOCK                                          │
└─────────────────────────┬───────────────────────────────────┘
                          │
                          ▼
┌─────────────────────────────────────────────────────────────┐
│  3. Validate: Is command in whitelist?                      │
│     → If no: REJECT with safe message                       │
└─────────────────────────┬───────────────────────────────────┘
                          │
                          ▼
┌─────────────────────────────────────────────────────────────┐
│  4. Rate Limit: Has user/PR exceeded limits?                │
│     → If yes: REJECT with rate limit message                │
└─────────────────────────┬───────────────────────────────────┘
                          │
                          ▼
┌─────────────────────────────────────────────────────────────┐
│  5. Execute: Call Z.ai API, format response                 │
│     → Sanitize all outputs                                  │
└─────────────────────────────────────────────────────────────┘
```

## Changelog

- **2025-02-23**: Initial security policy document
