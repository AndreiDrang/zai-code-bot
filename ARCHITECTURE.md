# Architecture

## 1. High-Level Overview

**zai-code-bot** is a JavaScript GitHub Action that provides automated PR code review and interactive `/zai` commands powered by Z.ai models. It runs in GitHub Actions workflows and responds to pull request events and comment commands.

**Observed Purpose**: The system solves two problems:
1. Automatic code review when PRs are opened or updated
2. Interactive assistant commands for asking questions, explaining code, suggesting improvements, and more

**Paradigm**: Event-driven action with command dispatch pattern. GitHub events flow through a central orchestrator (`src/index.js`) which parses, authorizes, and routes to specialized handlers.

**Evidence Anchors**:
- `action.yml` — GitHub Action metadata, declares Node 20 runtime and `dist/index.js` entrypoint
- `src/index.js` — Main orchestrator with event routing and command dispatch
- `src/lib/handlers/` — Command-specific implementations (6 handlers)
- `package.json` — Declares `@actions/core` and `@actions/github` dependencies
- `.github/workflows/ci.yml` — CI pipeline with test/build/drift-check gates

---

## 2. System Architecture (Logical)

The system has four logical layers:

```
┌─────────────────────────────────────────────────────────────┐
│                    GitHub Events Layer                       │
│  (pull_request, issue_comment, pull_request_review_comment) │
└──────────────────────────┬──────────────────────────────────┘
                           ▼
┌─────────────────────────────────────────────────────────────┐
│                   Event Router (src/index.js)                │
│  • Event type detection (events.js)                         │
│  • Command parsing (commands.js)                            │
│  • Authorization gating (auth.js)                           │
└──────────────────────────┬──────────────────────────────────┘
                           ▼
┌─────────────────────────────────────────────────────────────┐
│                 Command Handlers (lib/handlers/)             │
│  ask | describe | explain | help | impact | review          │
└──────────────────────────┬──────────────────────────────────┘
                           ▼
┌─────────────────────────────────────────────────────────────┐
│                    External Services                         │
│  • Z.ai API (api.js)     • GitHub API (octokit)             │
└─────────────────────────────────────────────────────────────┘
```

**Dependency Direction**:
- `src/index.js` → `src/lib/*` → handlers → external APIs
- Handlers may depend on utilities (`api.js`, `comments.js`, `context.js`, etc.)
- Utilities do NOT depend on handlers
- No circular dependencies observed

**Intentional Non-Dependencies**:
- `dist/` is generated output — never imported by source
- Test files do not import from `dist/`
- Handlers do not directly import from each other

---

## 3. Code Map (Physical)

```
zai-code-bot/
├── src/
│   ├── index.js              # Main orchestrator: event routing, command dispatch
│   └── lib/
│       ├── api.js            # Z.ai HTTP client with retry/backoff
│       ├── auth.js           # Collaborator/fork authorization policy
│       ├── code-scope.js     # Sliding window + enclosing block extraction
│       ├── commands.js       # /zai parser, command allowlist
│       ├── comments.js       # Marker-based idempotent comments, reactions
│       ├── context.js        # Context budget, line extraction utilities
│       ├── continuity.js     # Hidden marker state persistence
│       ├── events.js         # Event type detection, anti-loop filtering
│       ├── logging.js        # Structured logging, error categorization
│       ├── pr-context.js     # PR file fetching, large file scoping
│       └── handlers/
│           ├── index.js      # Handler registry (HANDLERS map)
│           ├── ask.js        # /zai ask — Q&A with continuity state
│           ├── describe.js   # /zai describe — PR description from commits
│           ├── explain.js    # /zai explain — line range explanation
│           ├── help.js       # /zai help — static help output
│           ├── impact.js     # /zai impact — risk analysis + auto-labeling
│           └── review.js     # /zai review — targeted file review
│
├── tests/
│   ├── *.test.js             # Module-level unit tests
│   ├── handlers/             # Handler-specific tests
│   ├── helpers/              # Shared mocks and fixtures
│   ├── fixtures/             # Static test payloads
│   └── integration/          # End-to-end pipeline tests
│
├── dist/
│   ├── index.js              # Bundled action (ncc output, DO NOT EDIT)
│   └── licenses.txt          # Third-party license notices
│
├── .github/workflows/
│   ├── ci.yml                # CI: test, build, dist-drift, security-audit
│   └── code-review.yml       # Example consumer workflow
│
├── action.yml                # GitHub Action inputs and runtime config
├── package.json              # Dependencies and build scripts
└── AGENTS.md                 # AI agent knowledge base (micro-level docs)
```

**Where to Find X**:
- Event routing logic → `src/index.js` (functions: `run`, `handlePullRequestEvent`, `handleIssueCommentEvent`, `dispatchCommand`)
- Command parsing → `src/lib/commands.js`
- Authorization rules → `src/lib/auth.js`
- Comment posting logic → `src/lib/comments.js`
- API retry behavior → `src/lib/api.js`
- Adding a new command → `src/lib/handlers/` + register in `commands.js` and `handlers/index.js`

---

## 4. Life of a Request / Primary Data Flow

### PR Auto-Review Flow
```
GitHub: pull_request (opened/synchronize)
    │
    ▼
src/index.js:handlePullRequestEvent()
    │
    ├─► events.js:shouldProcessEvent() ──► Filter bots, validate PR
    │
    ├─► context.js:fetchChangedFiles() ──► Get file list from GitHub
    │
    ├─► Build review prompt from diffs
    │
    ├─► api.js:createApiClient().call() ──► Z.ai API
    │
    └─► comments.js:upsertComment() ──► Post/update review comment
```

### Command Flow (e.g., `/zai ask`)
```
GitHub: issue_comment or pull_request_review_comment
    │
    ▼
src/index.js:handleIssueCommentEvent()
    │
    ├─► events.js:shouldProcessEvent() ──► Skip non-PR comments, bots
    │
    ├─► commands.js:parseCommand() ──► Extract command + args
    │
    ├─► auth.js:checkForkAuthorization() ──► Gate access
    │
    ├─► comments.js:setReaction(THINKING) ──► Visual feedback
    │
    ├─► dispatchCommand() ──► Route to handler
    │       │
    │       ▼
    │   handlers/ask.js:handleAskCommand()
    │       │
    │       ├─► continuity.js:loadContinuityState() ──► Load prior context
    │       ├─► Build prompt with PR context
    │       ├─► api.js:apiClient.call() ──► Z.ai API
    │       └─► comments.js:upsertComment({ replyToId }) ──► Threaded reply
    │
    └─► comments.js:setReaction(ROCKET or X) ──► Final status
```

---

## 5. Architectural Invariants & Constraints

### 5.1 Build Artifact Integrity
- **Rule**: Never edit `dist/index.js` or `dist/licenses.txt` by hand
- **Rationale**: These are generated by `ncc` bundler; manual edits will be overwritten and cause drift failures
- **Enforcement**: CI `dist-drift` job fails if `dist/` differs from build output

### 5.2 Source-Build Consistency
- **Rule**: Every source change must be accompanied by a rebuild and commit of `dist/`
- **Rationale**: GitHub Actions executes `dist/index.js`, not source files
- **Enforcement**: CI `dist-drift` check; convention documented in `AGENTS.md`

### 5.3 Authorization Gating
- **Rule**: All command handlers must check authorization before execution
- **Rationale**: Prevents unauthorized users from consuming API quota or injecting prompts
- **Enforcement**: `auth.js:checkForkAuthorization()` called in `handleIssueCommentEvent()` before dispatch

### 5.4 Idempotent Comments
- **Rule**: All bot comments must include a unique HTML marker for upsert logic
- **Rationale**: Prevents duplicate comment spam on re-runs or multiple triggers
- **Enforcement**: `comments.js:upsertComment()` requires `marker` parameter; `findCommentByMarker()` deduplicates

### 5.5 Threaded Command Replies
- **Rule**: Command responses must be threaded to the invoking comment via `replyToId`
- **Rationale**: Maintains conversation context, avoids top-level comment clutter
- **Enforcement**: `upsertComment()` called with `replyToId: commentId` in handlers

### 5.6 Context Budget
- **Rule**: All prompts must be bounded; never pass unbounded file content to LLM
- **Rationale**: Prevents token overflow and API failures on large files
- **Enforcement**: `context.js:truncateContext()` with `DEFAULT_MAX_CHARS = 8000`; `code-scope.js` for large file windows

### 5.7 No Secret Leakage
- **Rule**: Error messages and logs must never contain API keys, tokens, or credentials
- **Rationale**: Security; logs are visible in GitHub Actions UI
- **Enforcement**: `api.js:sanitizeErrorMessage()` strips Bearer tokens and API keys; `logging.js:redactSensitiveData()` redacts sensitive fields from log objects

### 5.8 Anti-Loop Protection
- **Rule**: Bot must not respond to its own comments
- **Rationale**: Prevents infinite comment loops
- **Enforcement**: `events.js:isBotComment()` rejects bot-authored comments

---

## 6. Documentation Strategy

### Hierarchy
- **`ARCHITECTURE.md`** (this file) — High-level map, invariants, and data flow
- **`AGENTS.md`** — Project knowledge base for AI agents; includes code map and conventions
- **`src/lib/handlers/AGENTS.md`** — Handler-specific patterns and testing guidance
- **`tests/AGENTS.md`** — Test strategy and fixture conventions
- **`README.md`** — User-facing quickstart and command reference
- **`CONTRIBUTING.md`** — Developer contribution guidelines

### What Goes Where
| Information Type | Location |
|------------------|----------|
| System overview, layer diagram | `ARCHITECTURE.md` |
| Where to find specific logic | `AGENTS.md` CODE MAP section |
| Handler implementation patterns | `src/lib/handlers/AGENTS.md` |
| Test conventions and fixtures | `tests/AGENTS.md` |
| User command syntax | `README.md` |
| Adding new commands/modules | `AGENTS.md` + `ARCHITECTURE.md` invariants |
| CI/CD pipeline details | `.github/workflows/ci.yml` (self-documenting) |

### Module-Level Docs
Individual modules (e.g., `api.js`, `auth.js`) do not have separate README files. Instead:
- Function-level comments explain purpose and parameters
- `AGENTS.md` provides the "where to look" map
- `tests/*.test.js` serve as executable documentation for expected behavior