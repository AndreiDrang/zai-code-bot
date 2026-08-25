# 📋 GitHub App Authentication Implementation Plan

## 🎯 Overview

This document outlines the implementation plan for switching zai-code-bot from Personal Access Token (PAT) authentication to GitHub App authentication. This change enables the bot to post comments as a GitHub App (type 'Bot') instead of as a user, improving security and scalability.

## 📅 Timeline

| Phase                               | Duration      | Priority |
| ----------------------------------- | ------------- | -------- |
| Phase 1: Infrastructure Preparation | 1-2 days      | ⭐⭐⭐   |
| Phase 2: Core Development           | 2-3 days      | ⭐⭐⭐   |
| Phase 3: Integration                | 2-3 days      | ⭐⭐⭐   |
| Phase 4: Testing                    | 2-3 days      | ⭐⭐⭐   |
| Phase 5: Deployment                 | 1 day         | ⭐⭐⭐   |
| **Total**                           | **8-12 days** |          |

---

## 🏗️ Phase 1: Infrastructure Preparation

### Task 1.1: Create GitHub App

**Assignee:** DevOps / Backend Engineer  
**Duration:** 1 day  
**Status:** ⬜ Pending

#### Steps

1. Navigate to [GitHub → Settings → Developer settings → GitHub Apps](https://github.com/settings/apps)
2. Click **"New GitHub App"**
3. Fill in:
   - **GitHub App name:** `zai-code-bot`
   - **Homepage URL:** `https://zai-worker.tokenbel.info`
   - **Callback URL:** (leave empty)
   - **Description:** `AI-powered code review assistant for pull requests`

4. **Configure Permissions:**

   | Section             | Permission    | Reason                                                                                                                                                                         |
   | ------------------- | ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
   | Repository contents | Read-only     | Read files for context                                                                                                                                                         |
   | Pull requests       | Read & Write  | Read PR, post comments                                                                                                                                                         |
   | Issues              | Read & Write  | Read issue, post comments                                                                                                                                                      |
   | Comments            | Read & Write  | Manage comments                                                                                                                                                                |
   | Repository metadata | Read-only     | Get repository info                                                                                                                                                            |
   | **Collaborators**   | **Read-only** | **`GET /repos/{o}/{r}/collaborators/{user}` — the `/zai` authorization gate. Without it GitHub returns 403 "Resource not accessible by integration" and every command fails.** |

5. **Subscribe to Events:**
   - ✅ `Issue comment`
   - ✅ `Pull request`
   - ✅ `Pull request review comment`

6. **Generate Private Key:**
   - Click **"Generate a private key"**
   - Save the `.pem` file securely (it's only shown once!)
   - Store in secure password manager (1Password, Vault, etc.)

7. **Record App ID:**
   - Note the **App ID** (e.g., `123456`) from the app settings page

8. **Install the App:**
   - Click **"Install App"**
   - Select organizations/accounts for testing
   - Note the **Installation ID** for testing

#### Artifacts

- `GITHUB_APP_ID` (e.g., `123456`)
- `GITHUB_APP_PRIVATE_KEY` (contents of `.pem` file)
- `TEST_INSTALLATION_ID` (for testing)

---

### Task 1.2: Configure Cloudflare Secrets

**Assignee:** DevOps  
**Duration:** 1 day  
**Status:** ⬜ Pending

#### Steps

```bash
# Add new secrets to existing Secrets Store
# Store ID: 629e5dd6594845a889e6ddabb26cc009

# 1. Add ZAI_GITHUB_APP_ID (numeric App ID from the GitHub App settings page)
npx wrangler secrets-store secret create 629e5dd6594845a889e6ddabb26cc009 \
  --name ZAI_GITHUB_APP_ID --scopes workers --comment "zai-code-bot GitHub App ID" --remote
# paste the numeric App ID at the value prompt

# 2. Add ZAI_GITHUB_APP_PRIVATE_KEY (full PEM from the App's .pem file, real newlines)
cat zai-code-bot.pem | npx wrangler secrets-store secret create 629e5dd6594845a889e6ddabb26cc009 \
  --name ZAI_GITHUB_APP_PRIVATE_KEY --scopes workers --comment "zai-code-bot GitHub App private key" --remote
# if the .pem was lost: GitHub App settings -> "Generate a new private key"
# to rotate later: wrangler secrets-store secret update <store-id> --name ... --remote
```

#### Verification

```bash
# Verify secrets were added (note: --remote is required; default is local mode)
npx wrangler secrets-store secret list 629e5dd6594845a889e6ddabb26cc009 --remote
```

#### Artifacts

- Secrets `ZAI_GITHUB_APP_ID` and `ZAI_GITHUB_APP_PRIVATE_KEY` in Cloudflare Secrets Store

---

### Task 1.3: Update Wrangler Configuration

**Assignee:** Backend Engineer  
**Duration:** 1 day  
**Status:** ⬜ Pending

#### Steps

1. **Update `src/zai-main-worker/wrangler.toml`**

   ```toml
   # Add new bindings for GitHub App
   [[secrets_store_secrets]]
   binding = "GITHUB_APP_ID"
   store_id = "629e5dd6594845a889e6ddabb26cc009"
   secret_name = "ZAI_GITHUB_APP_ID"

   [[secrets_store_secrets]]
   binding = "GITHUB_APP_PRIVATE_KEY"
   store_id = "629e5dd6594845a889e6ddabb26cc009"
   secret_name = "ZAI_GITHUB_APP_PRIVATE_KEY"
   ```

2. **Update `src/zai-heavy-worker/wrangler.toml`**

   ```toml
   # Add the same bindings
   [[secrets_store_secrets]]
   binding = "GITHUB_APP_ID"
   store_id = "629e5dd6594845a889e6ddabb26cc009"
   secret_name = "ZAI_GITHUB_APP_ID"

   [[secrets_store_secrets]]
   binding = "GITHUB_APP_PRIVATE_KEY"
   store_id = "629e5dd6594845a889e6ddabb26cc009"
   secret_name = "ZAI_GITHUB_APP_PRIVATE_KEY"
   ```

#### Artifacts

- Updated `wrangler.toml` files

---

### Task 1.4: Create Database Migration

**Assignee:** Backend Engineer  
**Duration:** 1 day  
**Status:** ⬜ Pending

#### Steps

1. **Create migration file:** `src/zai-main-worker/migrations/0004_add_installation_id.sql`

   ```sql
   -- Migration: Add installation_id to jobs table for GitHub App authentication
   -- Up: Add installation_id column to jobs table

   ALTER TABLE jobs ADD COLUMN installation_id INTEGER;

   -- Create index for installation_id to speed up queries
   CREATE INDEX IF NOT EXISTS idx_jobs_installation_id ON jobs(installation_id);

   -- Add installation_id to webhook_deliveries table for tracking
   ALTER TABLE webhook_deliveries ADD COLUMN installation_id INTEGER;

   -- Add installation_id to repositories table for reference
   ALTER TABLE repositories ADD COLUMN github_app_installation_id INTEGER;
   ```

#### Artifacts

- New migration `0004_add_installation_id.sql`

---

## 💻 Phase 2: Core Development

### Task 2.1: Create GitHub App Authentication Module

**Assignee:** Backend Engineer  
**Duration:** 2 days  
**Status:** ⬜ Pending

#### Steps

1. **Create file:** `src/shared/github-app-auth.js`

   This module should include:

   - **`generateAppJwt(appId, privateKey)`**: Generates a JWT token signed with the app's private key
   - **`getInstallationToken(jwt, installationId)`**: Fetches an installation access token from GitHub
   - **`AppTokenCache`**: Class for caching installation tokens using KV namespace
   - **`createTokenProvider(env)`**: Factory function that handles JWT generation and caching

2. **Key Implementation Details:**
   - JWT should expire in 9 minutes (GitHub recommends max 10 minutes)
   - Use Web Crypto API for JWT signing (available in Cloudflare Workers)
   - Handle private key normalization (remove headers, whitespace)
   - Cache tokens for 5 minutes to avoid generating JWT for every request

3. **Error Handling:**

   > **⚠ SUPERSEDED by [`PAT_REMOVAL_PLAN.md`](./PAT_REMOVAL_PLAN.md):** PAT
   > fallback has been removed — GitHub App auth is the only auth path. Auth
   > failures are loud (503 in the main worker, classified fail/retry in the
   > queue), never silent fallbacks.
   - Classified `appAuthError` codes: `app_token_fetch_failed` (retryable),
     `app_jwt_rejected`, `app_suspended`, `installation_not_found`,
     `app_auth_unconfigured`, `missing_installation_id` (all permanent)

#### Artifacts

- `src/shared/github-app-auth.js`
- `src/tests/github-app-auth.test.js` (tests for the module)

---

### Task 2.2: Update GitHubClient

**Assignee:** Backend Engineer  
**Duration:** 1 day  
**Status:** ⬜ Pending

#### Steps

1. **Update `src/shared/github.js`**

   Modify the constructor to accept an `isApp` option:

   ```javascript
   constructor(token, opts = {}) {
     this.token = token;
     this.baseUrl = GITHUB_API_BASE;
     this.userAgent = opts.userAgent || 'zai-code-bot-workers';
     this.isApp = opts.isApp || false; // NEW
   }
   ```

2. **Update the `request` method** to use `Bearer` for App tokens:

   ```javascript
   const options = {
     method,
     headers: {
       Authorization: this.isApp ? `Bearer ${this.token}` : `token ${this.token}`,
       Accept: 'application/vnd.github+json',
       'X-GitHub-Api-Version': '2022-11-28',
       'User-Agent': this.userAgent,
     },
   };
   ```

3. **Update JSDoc comments** to reflect support for both PAT and Installation Tokens

#### Artifacts

- Updated `src/shared/github.js`

---

## 🔧 Phase 3: Integration

### Task 3.1: Update Main Worker

**Assignee:** Backend Engineer  
**Duration:** 2 days  
**Status:** ⬜ Pending

#### Steps

1. **Add import for token provider:**

   ```javascript
   import { createTokenProvider } from '../../shared/github-app-auth.js';
   ```

2. **Create helper function for GitHub client creation:**

   > **⚠ SUPERSEDED by [`PAT_REMOVAL_PLAN.md`](./PAT_REMOVAL_PLAN.md):** the
   > PAT fallback below was removed. `createAppGitHubClient` is App-only,
   > built lazily on the command path (PR events mint no tokens), and throws
   > `status: 503` errors so GitHub redelivers on auth/config failures.

   ```javascript
   async function createGitHubClient(env, installationId, logger) {
     // Try GitHub App authentication first
     if (installationId && env.GITHUB_APP_ID && env.GITHUB_APP_PRIVATE_KEY) {
       try {
         const tokenProvider = createTokenProvider(env);
         const token = await tokenProvider.getInstallationToken(installationId);
         logger.info('Using GitHub App authentication', { installationId });
         return { github: new GitHubClient(token, { isApp: true }), isAppAuth: true };
       } catch (appAuthError) {
         logger.warn('GitHub App authentication failed, falling back to PAT', {
           error: appAuthError.message,
           installationId,
         });
       }
     }

     // Fallback to PAT
     const token = await resolveSecretValue(env.GITHUB_TOKEN);
     logger.info('Using PAT authentication');
     return { github: new GitHubClient(token), isAppAuth: false };
   }
   ```

3. **Update `fetch` handler** to:
   - Extract `installationId` from webhook payload
   - Use the new `createGitHubClient` function
   - Pass `installationId` to job creation functions

4. **Update `createCommandDurableJob`** to include `installationId`:

   ```javascript
   async function createCommandDurableJob(
     env,
     github,
     webhookData,
     kind,
     deliveryId,
     installationId,
   ) {
     // ... existing code ...
     const event = {
       // ... existing fields ...
       installationId: installationId,
     };
     return createCommandJob(env.BOT_DB, event, kind);
   }
   ```

5. **Update `createPrContextJob` calls** to pass `installationId`

#### Artifacts

- Updated `src/zai-main-worker/src/index.js`

---

### Task 3.2: Update Heavy Worker

**Assignee:** Backend Engineer  
**Duration:** 2 days  
**Status:** ⬜ Pending

#### Steps

1. **Add import for token provider:**

   ```javascript
   import { createTokenProvider } from '../../shared/github-app-auth.js';
   ```

2. **Create helper function for queue GitHub client:**

   > **⚠ SUPERSEDED by [`PAT_REMOVAL_PLAN.md`](./PAT_REMOVAL_PLAN.md):** no
   > PAT fallback — the strict version fails the job for permanent auth
   > errors (`missing_installation_id`, `app_auth_unconfigured`,
   > `app_jwt_rejected`) and retries only transient mint failures.

   ```javascript
   async function createQueueGitHubClient(env, job, logger) {
     const installationId = job.installation_id;

     if (installationId && env.GITHUB_APP_ID && env.GITHUB_APP_PRIVATE_KEY) {
       try {
         const tokenProvider = createTokenProvider(env);
         const token = await tokenProvider.getInstallationToken(installationId);
         logger.info('Using GitHub App authentication for queue job', {
           installationId,
           jobId: job.job_id,
         });
         return new GitHubClient(token, { isApp: true });
       } catch (appAuthError) {
         logger.warn('GitHub App authentication failed in queue, falling back to PAT', {
           error: appAuthError.message,
           installationId,
           jobId: job.job_id,
         });
       }
     }

     // Fallback to PAT
     const token = await resolveSecretValue(env.GITHUB_TOKEN);
     logger.info('Using PAT authentication for queue job', { jobId: job.job_id });
     return new GitHubClient(token);
   }
   ```

3. **Update `processQueueMessage`** to use the new client creation function

#### Artifacts

- Updated `src/zai-heavy-worker/src/queue.js`

---

### Task 3.3: Update Storage Layer

**Assignee:** Backend Engineer  
**Duration:** 1 day  
**Status:** ⬜ Pending

#### Steps

1. **Update `src/shared/storage/deliveries.js`**

   - Add `installation_id` to the JOB_BASE query
   - Update `createPrJob` to accept and store `installationId`
   - Update `createPrContextJob` to accept `installationId` parameter
   - Update `createCommandJob` to pass `installationId` to `createPrJob`

2. **Example changes:**

   ```javascript
   const JOB_BASE = `
     SELECT j.job_id, j.delivery_id, j.kind, j.repository_id, j.pr_number,
            j.head_sha, p.base_sha,
            j.status, j.attempt_count, j.available_at, j.claimed_at, j.lease_expires_at,
            j.completed_at, j.last_error_code, j.last_failure_at, j.config_version,
            j.installation_id,  // NEW
            r.owner AS repository_owner, r.name AS repository_name, r.full_name AS repository_full_name,
            p.title, p.author_login, p.state, p.closed_by
     FROM jobs j
     JOIN repositories r ON r.repository_id = j.repository_id
     JOIN pull_requests p ON p.repository_id = j.repository_id AND p.pr_number = j.pr_number
   `;

   // In createPrJob function:
   const installationId = event.installationId || null;

   // In SQL INSERT:
   `INSERT INTO jobs
    (job_id, delivery_id, kind, repository_id, pr_number, head_sha, installation_id, status,
     attempt_count, available_at, config_version, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'queued', 0, ?, 1, ?, ?)`;
   ```

#### Artifacts

- Updated `src/shared/storage/deliveries.js`

---

## 🧪 Phase 4: Testing

### Task 4.1: Unit Tests

**Assignee:** QA Engineer / Backend Engineer  
**Duration:** 2 days  
**Status:** ⬜ Pending

#### Steps

1. **Create tests for `github-app-auth.js`:**
   - Test JWT generation
   - Test Installation Token fetching (mock fetch)
   - Test token caching
   - Test error handling

2. **Update existing tests:**
   - Update `github.test.js` to test both PAT and App authentication
   - Update `index-fetch.test.js` to test new authentication flow
   - Update `queue.test.js` to test queue authentication

3. **Test coverage goals:**
   - 100% coverage for new `github-app-auth.js` module
   - Maintain existing coverage levels

#### Artifacts

- `src/tests/github-app-auth.test.js`
- Updated existing test files

---

### Task 4.2: Integration Testing

**Assignee:** QA Engineer  
**Duration:** 2 days  
**Status:** ⬜ Pending

#### Steps

1. **Local Testing:**
   - Run workers locally with test secrets
   - Verify JWT generation
   - Verify Installation Token retrieval

2. **Staging Testing:**
   - Deploy to staging environment
   - Install GitHub App on test repository
   - Verify:
     - Comments are posted as the app (`type === 'Bot'`)
     - All commands work (`/zai review`, `/zai describe`)
     - Authorization works correctly

3. **Comment Ownership Testing:**
   - Verify that comments belong to the bot (`isBotOwnedComment`)
   - Test updating existing comments

#### Artifacts

- Test report
- Error logs (if any)

---

### Task 4.3: Load Testing

**Assignee:** DevOps  
**Duration:** 1 day  
**Status:** ⬜ Pending

#### Steps

1. **Token Caching Tests:**
   - Verify tokens are not generated for every request
   - Check performance with caching enabled

2. **Concurrent Request Tests:**
   - Verify multiple requests don't break authentication
   - Check for race conditions

#### Artifacts

- Load test results

---

## 🚀 Phase 5: Deployment

### Task 5.1: Deployment Preparation

**Assignee:** DevOps  
**Duration:** 1 day  
**Status:** ⬜ Pending

#### Steps

1. **Create release branch:**

   ```bash
   git checkout -b feature/github-app-auth
   git merge main
   ```

2. **Verify all changes:**
   - Ensure all files are updated
   - Run all tests

3. **Update documentation:**
   - Update `README.md` with GitHub App setup instructions
   - Update `RUNBOOK.md` with new authentication troubleshooting

---

### Task 5.2: Deploy to Production

**Assignee:** DevOps  
**Duration:** 1 day  
**Status:** ⬜ Pending

#### Steps

1. **Deploy main-worker:**

   ```bash
   cd src/zai-main-worker
   npx wrangler deploy
   ```

2. **Deploy heavy-worker:**

   ```bash
   cd src/zai-heavy-worker
   npx wrangler deploy
   ```

3. **Apply database migrations:**

   ```bash
   npx wrangler d1 execute bot-db --file=../migrations/0004_add_installation_id.sql
   ```

4. **Configure GitHub App Webhook:**
   - Remove old webhook (if any)
   - Create new webhook from GitHub App:
     - **Payload URL:** `https://zai-worker.tokenbel.info/github/webhook`
     - **Content type:** `application/json`
     - **Secret:** `ZAI_GITHUB_WEBHOOK_KEY` (same as before)
     - **Events:** `Issue comment`, `Pull request`, `Pull request review comment`

---

### Task 5.3: Monitoring and Rollback

**Assignee:** DevOps  
**Duration:** 3 days  
**Status:** ⬜ Pending

#### Steps

1. **Post-deployment monitoring:**
   - Check Cloudflare Workers logs
   - Verify comments are posted as the app
   - Ensure no authentication errors

2. **Rollback plan:**
   - If something goes wrong:
     - Revert to PAT by removing GitHub App usage
     - Restore old webhook
     - Remove new secrets

3. **Update status:**
   - Close the task after successful deployment
   - Document changes

---

## 📊 Success Metrics

| Metric                      | Target Value         | Current Value |
| --------------------------- | -------------------- | ------------- |
| Comments from app           | 100%                 | 0%            |
| Authentication success rate | 99.9%                | 99% (PAT)     |
| Token generation time       | < 100ms (with cache) | N/A           |
| API response time           | No change            | Baseline      |
| Error count                 | 0                    | Current       |

---

## 🎯 Risks and Mitigations

| Risk                               | Probability | Impact   | Mitigation                              |
| ---------------------------------- | ----------- | -------- | --------------------------------------- |
| JWT generation errors              | Low         | High     | Test locally, use proven libraries      |
| Installation Token issues          | Medium      | High     | Fallback to PAT, monitor errors         |
| Incompatibility with existing jobs | Medium      | Medium   | Update database schema, data migration  |
| Webhook issues                     | Low         | High     | Test in staging, monitor logs           |
| Secret leakage                     | Very Low    | Critical | Use Cloudflare Secrets, restrict access |

---

## 📚 Documentation Updates

### Files to Update

1. **README.md**
   - Add section on GitHub App setup
   - Update deployment instructions

2. **RUNBOOK.md**
   - Add troubleshooting for GitHub App authentication
   - Describe how to check comment types

3. **ARCHITECTURE.md**
   - Update authentication flow diagrams
   - Describe new flow

---

## 🏆 Acceptance Criteria

- [ ] GitHub App created and configured
- [ ] Cloudflare Secrets updated
- [ ] GitHub App authentication code written and tested
- [ ] GitHubClient supports both authentication types
- [ ] Main Worker uses GitHub App authentication
- [ ] Heavy Worker uses GitHub App authentication
- [ ] All tests pass
- [ ] Comments are posted as the app (`type === 'Bot'`)
- [ ] Fallback to PAT works when GitHub App config is missing
- [ ] Documentation updated
- [ ] Deployment to production completed
- [ ] Monitoring shows stable operation

---

## 📞 Contacts

| Role             | Responsible | Contact          |
| ---------------- | ----------- | ---------------- |
| Project Lead     | [Your Name] | @your-github     |
| Backend Engineer | [Name]      | @backend-dev     |
| DevOps           | [Name]      | @devops-engineer |
| QA Engineer      | [Name]      | @qa-engineer     |

---

## 🎉 Conclusion

This plan provides a **smooth transition** from PAT to GitHub App Authentication with:

- ✅ Minimal downtime (fallback to PAT)
- ✅ Full backward compatibility
- ✅ Improved security
- ✅ Scalability

**Next Steps:**

1. Start with **Phase 1: Infrastructure Preparation**
2. Create GitHub App and obtain App ID + Private Key
3. Add secrets to Cloudflare
4. Proceed to development (Phase 2)
