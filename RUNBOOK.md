# Operational Runbook

This document provides operational guidance for running and maintaining the Z.ai Code Review GitHub Action. It covers common failure scenarios, diagnosis procedures, rollback steps, and escalation paths.

## Overview

The Z.ai Code Review action runs as a GitHub Actions workflow, analyzing pull request diffs and posting AI-powered reviews. Understanding the action's architecture helps with troubleshooting.

```
PR Event → GitHub Actions → Checkout → Run Action → Z.ai API → Post Comment
```

## Common Failure Scenarios

### 1. Z.ai API Failures

**Symptoms:**
- Action fails with HTTP error code
- Review comment not posted
- Logs show "API request failed" or "connection error"

**Diagnosis Steps:**

1. Check action logs for specific error code:
   - `401`: Invalid or expired API key
   - `429`: Rate limit exceeded
   - `500-599`: Z.ai server error

2. Verify API key is valid:
   - Check `ZAI_API_KEY` secret exists in repository
   - Confirm key has not expired in Z.ai dashboard

3. Check rate limits:
   - Z.ai account tier determines limit
   - Review recent usage in Z.ai dashboard

**Resolution:**
- For 401 errors: Update the `ZAI_API_KEY` secret
- For 429 errors: Wait for rate limit reset or upgrade tier
- For 5xx errors: Wait and retry; escalate to Z.ai support if persistent

### 2. GitHub API Permission Errors

**Symptoms:**
- Action fails with "Resource not found" or "Forbidden"
- No comment posted on PR
- Permission-related errors in logs

**Diagnosis Steps:**

1. Verify workflow permissions:
   ```yaml
   permissions:
     contents: read
     pull-requests: write
   ```

2. Check if token has required scopes
3. Confirm repository allows actions and bots

**Resolution:**
- Update workflow file with correct permissions
- For private repos: ensure GitHub Actions enabled
- For organization repos: check org-level permission settings

### 3. PR Context Not Available

**Symptoms:**
- Error: "No pull request found"
- Action runs but posts no review
- Logs show empty diff or missing PR number

**Diagnosis Steps:**

1. Confirm workflow triggers on correct events:
   ```yaml
   on:
     pull_request:
       types: [opened, synchronize]
   ```

2. Check if PR exists and is not closed
3. Verify `github.event.pull_request` is available

**Resolution:**
- Ensure workflow triggers match expected events
- For `push` events, manually extract PR number using `github.event.inputs`

### 4. Large Diff Handling

**Symptoms:**
- Action times out
- Partial review posted
- Truncation warnings in logs

**Diagnosis Steps:**

1. Check diff size in action logs
2. Look for "diff too large" messages

**Resolution:**
- Limit files changed per PR
- Ask users to split large PRs
- Action automatically truncates at 50 files

### 5. Fork PR Handling Issues

**Symptoms:**
- Action behaves differently for fork PRs
- Collaborator commands blocked unexpectedly

**Diagnosis Steps:**

1. Check if PR is from fork:
   - `github.event.pull_request.head.repo.fork` = true

2. Verify collaborator status for non-collaborators
3. Review SECURITY.md for fork handling rules

**Resolution:**
- Fork PRs allow auto-review but block interactive commands for non-collaborators
- Add fork authors as collaborators if commands needed

## Health Check Procedures

### Daily Health Check

Run these checks daily to ensure the action is functioning:

1. **Verify recent workflow runs:**
   - Check recent PRs have review comments
   - Confirm no failed action runs

2. **Check API key validity:**
   - Confirm key not expired
   - Test API connectivity

3. **Review action logs:**
   - No new error patterns
   - Response times within normal range

### Weekly Health Check

1. **Review usage metrics:**
   - Total reviews this week
   - API calls consumed
   - Any anomalies in usage

2. **Check GitHub Actions usage:**
   - Verify minutes consumption
   - Review any queued or failed runs

## Monitoring and Logging

### Where to Find Logs

1. **GitHub Actions Logs:**
   - Navigate to repository → Actions → Select workflow run
   - Each step shows timestamp and output

2. **Log Levels:**
   - Action uses `core.info()` for normal operations
   - `core.error()` for failures
   - `core.warning()` for recoverable issues

### Key Metrics to Monitor

| Metric | Normal Range | Alert Threshold |
|--------|--------------|------------------|
| Action duration | 10-30 seconds | > 60 seconds |
| API response time | 2-10 seconds | > 30 seconds |
| Failed runs | < 1% | > 5% |
| Reviews per day | Varies | Sudden drop to 0 |

### Debug Mode

To enable detailed debugging:

1. Add `ACTIONS_STEP_DEBUG` secret set to `true`
2. This enables GitHub's step debug logging
3. Check "Enable debug logging" in action settings

## Rollback Procedures

### Rolling Back to Previous Release

If a new release causes issues, rollback to a previous stable version.

**Step 1: Identify the Problematic Release**

```bash
# List recent tags
git tag -l --sort=-v:refname | head -10
```

**Step 2: Revert to Previous Tag**

In `.github/workflows/code-review.yml`:

```yaml
- uses: tarmojussila/zai-code-review@v0.1.0  # Previous working version
```

**Step 3: Verify Rollback**

1. Trigger a test PR review
2. Confirm action works correctly
3. Monitor for 24 hours

### Rolling Back Source Changes

If source code changes caused the issue:

**Step 1: Find Last Known Good Commit**

```bash
git log --oneline -20
# Look for last commit before issues started
```

**Step 2: Reset to Good Commit**

```bash
git checkout main
git reset --hard <good-commit-hash>
git push --force-with-lease
```

**Step 3: Rebuild and Release**

```bash
npm run build
git add dist/ src/
git commit -m "revert: rollback to stable version"
git tag v0.1.x
git push && git push --tags
```

## Escalation Paths

### Tier 1: Immediate Response (Self-Service)

**Who:** Repository maintainers

**Actions:**
- Check logs and error messages
- Verify configuration (API key, permissions)
- Review recent changes
- Attempt rollback if needed

**Time to escalate:** 30 minutes

### Tier 2: Technical Lead

**Who:** Senior developer / Tech lead

**When to escalate:**
- Issue persists after Tier 1 steps
- Root cause unclear
- Potential security implications

**Actions:**
- Deep code analysis
- Coordinate with external teams (GitHub, Z.ai)
- Plan fix or rollback

**Time to escalate:** 2 hours

### Tier 3: External Support

**Contact points:**

| Issue Type | Contact | Response Time |
|------------|---------|---------------|
| GitHub Actions platform | GitHub Support | 24-48 hours |
| Z.ai API issues | Z.ai support team | Varies |
| Security vulnerabilities | security@ related party | 24 hours |

**When to escalate:**
- Confirmed platform issue
- Security vulnerability confirmed
- No workaround available

## Contact Information

For operational issues, contact in order:

1. Repository maintainer (first response)
2. Technical lead (if unresolved)
3. External support (GitHub/Z.ai for platform issues)

## Related Documentation

- [CONTRIBUTING.md](CONTRIBUTING.md) - Release process and development guidelines
- [SECURITY.md](SECURITY.md) - Security policies and permission model
- [README.md](README.md) - User-facing setup and usage

## Changelog

- **2025-02-23**: Initial runbook document
