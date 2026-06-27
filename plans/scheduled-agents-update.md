# Scheduled AGENTS.md Update Feature - Integration Plan

## Overview

This document outlines the integration plan for adding **scheduled (cron-based) AGENTS.md file updates** to zai-code-bot. The feature will:

1. Run on a configurable schedule (default: weekly)
2. Fetch command text from a Gist URL
3. Execute the command to update AGENTS.md files
4. Create a PR with changes if files are modified
5. Support flexible YAML-based configuration
6. Provide extensible architecture for future scheduled tasks

---

## Architecture

### Current System Flow
```
GitHub Event → src/index.js (run()) → Event Router → Handler → Response
```

### Proposed Addition
```
schedule Event → src/index.js → handleScheduleEvent() → Scheduled Handler → PR Creation
```

### Key Components

| Component | File | Purpose |
|-----------|------|---------|
| Event Detection | `src/lib/events.js` | Detect and route schedule events |
| Configuration | `src/lib/config/scheduled-config.js` | Load and validate `.zai-scheduled.yml` |
| Main Handler | `src/lib/handlers/scheduled.js` | Execute scheduled tasks |
| Utility Functions | `src/lib/handlers/scheduled.js` | File operations, PR creation, URL fetching |

---

## Configuration

### File: `.zai-scheduled.yml` (Consumer Repository)

```yaml
version: 1

defaults:
  branch: main
  schedule: "0 0 * * 0"  # Weekly on Sunday
  gist_url: https://gist.githubusercontent.com/AndreiDrang/1580ae796fe56074b600cee6352a5f14/raw

tasks:
  - id: weekly-agents-update
    name: "Weekly AGENTS.md Update"
    enabled: true
    schedule: "0 0 * * 0"
    command: update-agents
    config:
      branch: main
      gist_url: https://gist.githubusercontent.com/AndreiDrang/1580ae796fe56074b600cee6352a5f14/raw
      files:
        - AGENTS.md
        - src/lib/AGENTS.md
      pr_title: "chore: update AGENTS.md files"
      pr_body: "Automated weekly update of AGENTS.md files from gist"
      commit_message: "docs: update AGENTS.md from scheduled task"
```

### Workflow File: `.github/workflows/zai-scheduled.yml` (Consumer Repository)

```yaml
name: Zai Scheduled Tasks

on:
  schedule:
    - cron: "0 0 * * 0"
  workflow_dispatch:

permissions:
  contents: write
  pull-requests: write

jobs:
  zai-scheduled:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0

      - uses: AndreiDrang/zai-code-bot@main
        with:
          ZAI_API_KEY: ${{ secrets.ZAI_API_KEY }}
          ZAI_MODEL: ${{ vars.ZAI_MODEL }}
          ZAI_SCHEDULED_ENABLED: "true"
```

---

## Implementation Phases

### Phase 1: Event Infrastructure (PRIORITY: HIGH)

**Files to Modify:**
- `src/lib/events.js` - Add `schedule` event type support
- `src/index.js` - Add schedule event routing

**Changes:**
```javascript
// In src/lib/events.js
function getEventType(context) {
  // ... existing
  if (eventName === 'schedule') {
    return 'schedule';
  }
  // ...
}

function shouldProcessEvent(context) {
  // ... existing
  if (eventType === 'schedule') {
    return { process: true, reason: 'schedule event' };
  }
  // ...
}
```

### Phase 2: Configuration System (PRIORITY: HIGH)

**New File:** `src/lib/config/scheduled-config.js`

**Functions:**
- `loadScheduledConfig(octokit, owner, repo, ref)` - Load and parse YAML config
- `validateConfig(config)` - Schema validation
- `getTasksToRun(config, eventSchedule)` - Filter tasks by schedule

### Phase 3: Scheduled Task Handler (PRIORITY: HIGH)

**New File:** `src/lib/handlers/scheduled.js`

**Main Functions:**
- `handleScheduledEvent(context, apiKey, model, owner, repo)` - Entry point
- `executeScheduledTask(params)` - Execute individual task
- `getScheduledHandler(command)` - Get handler for command
- `handleUpdateAgentsTask(context)` - **Main feature: Update AGENTS.md files**

**Utility Functions:**
- `fetchFromUrl(url)` - HTTP GET request
- `fetchFileContent(octokit, owner, repo, path, ref)` - Get file from GitHub
- `updateFileInRepo(octokit, owner, repo, path, content, ref, message)` - Update file
- `createPR(octokit, owner, repo, params)` - Create pull request with changes

**AGENTS.md Update Logic:**
1. Fetch command from Gist URL
2. Parse as `/zai` command
3. Execute command to generate new content
4. Compare with existing files
5. Create PR if changes detected

### Phase 4: Integration (PRIORITY: MEDIUM)

**Files to Modify:**
- `src/lib/handlers/index.js` - Export scheduled handler
- `action.yml` - Add new inputs:
  - `ZAI_SCHEDULED_ENABLED` (default: true)
  - `ZAI_SCHEDULED_CONFIG_PATH` (default: .zai-scheduled.yml)

### Phase 5: Optional Manual Command (PRIORITY: LOW)

For testing/debugging, add `/zai update-agents` command:
- `src/lib/commands.js` - Add to ALLOWED_COMMANDS
- `src/index.js` - Add case in dispatchCommand

---

## Extensibility Design

### Adding New Scheduled Commands

1. **Create handler function** in `scheduled.js`:
```javascript
async function handleNewTask(context) {
  // Custom logic here
  return { success: true, changes: [...], message: "..." };
}
```

2. **Register in handler map**:
```javascript
function getScheduledHandler(command) {
  const handlers = {
    'update-agents': handleUpdateAgentsTask,
    'new-task': handleNewTask,  // NEW
  };
  return handlers[command] || null;
}
```

3. **Add to configuration** (optional):
```yaml
tasks:
  - id: my-new-task
    command: new-task
    config:
      # Custom configuration
      setting1: value1
```

### Configuration Flexibility

- Each task receives full `task.config` object
- Handlers interpret configuration as needed
- Schema validation is optional per-task

---

## Error Handling

- Individual task failures don't stop other tasks
- All errors logged with correlation IDs
- No PR created on complete failure
- Partial success reported (some files updated, others failed)

---

## Security Considerations

- Uses existing `GITHUB_TOKEN` with repository scope
- Configuration validated against schema
- Gist URLs validated before fetching
- No user interaction (runs with repo permissions)
- Requires `contents: write` permission for PR creation

---

## Performance

- Sequential task execution with 5-second delays
- Respects GitHub API rate limits
- Memory bounded per task
- Typical execution: < 5 minutes

---

## Files Summary

### New Files
| File | Purpose |
|------|---------|
| `src/lib/config/scheduled-config.js` | Configuration loading/validation |
| `src/lib/handlers/scheduled.js` | Scheduled task handler |

### Modified Files
| File | Changes |
|------|---------|
| `src/lib/events.js` | Add schedule event support |
| `src/index.js` | Add schedule event routing |
| `action.yml` | Add new inputs |
| `src/lib/handlers/index.js` | Export scheduled handler |
| `src/lib/commands.js` | Add update-agents command (optional) |

### Consumer Files (Not in this repo)
| File | Purpose |
|------|---------|
| `.zai-scheduled.yml` | Task configuration |
| `.github/workflows/zai-scheduled.yml` | Workflow definition |

---

## Success Criteria

### MVP
- [ ] Schedule event detection works
- [ ] Configuration loading and validation works
- [ ] AGENTS.md update task executes successfully
- [ ] PR creation works when files change
- [ ] No PR created when no changes
- [ ] Error handling works for all scenarios
- [ ] All existing tests pass
- [ ] New tests cover 80%+ of new code

### Quality Gates
- [ ] No breaking changes to existing functionality
- [ ] Security review passed
- [ ] Performance acceptable
- [ ] Documentation complete

---

## Questions for Clarification

1. **Gist Content**: Does the gist contain a `/zai` command or raw AGENTS.md content?
   - Current assumption: Contains a `/zai` command to be parsed and executed

2. **PR Strategy**: Should each task create its own PR, or batch all changes?
   - Current assumption: Each task creates its own PR

3. **Branch Management**: Clean up old scheduled task branches?
   - Current assumption: No (can be added later)

---

## References

- [GitHub Schedule Events](https://docs.github.com/en/actions/using-workflows/events-that-trigger-workflows#schedule)
- [GitHub Octokit API](https://github.com/octokit/octokit.js)
- [YAML Package](https://www.npmjs.com/package/yaml)

---

*Created: 2026-06-27*
*Status: Ready for Implementation*
