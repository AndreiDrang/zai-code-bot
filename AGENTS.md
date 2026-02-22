# PROJECT KNOWLEDGE BASE

**Generated:** 2026-02-22T23:16:37Z
**Commit:** bab22f5
**Branch:** main

## OVERVIEW
JavaScript GitHub Action that reviews pull requests with Z.ai. Runtime executes prebuilt `dist/index.js`; maintained source is concentrated in `src/index.js`.

## STRUCTURE
```text
zai-code-bot/
├── src/index.js                  # Author-maintained action logic
├── dist/index.js                 # Generated ncc bundle executed by GitHub
├── dist/licenses.txt             # Generated third-party license output
├── action.yml                    # Action inputs/runtime entry metadata
├── package.json                  # Build command + dependency manifest
├── .github/workflows/code-review.yml  # Example workflow wiring
├── CONTRIBUTING.md               # Release/build rules
└── README.md                     # User-facing setup and usage
```

## WHERE TO LOOK
| Task | Location | Notes |
|------|----------|-------|
| Change review behavior | `src/index.js` | Core orchestration in `run()` and helper functions |
| Adjust action inputs/runtime | `action.yml` | Defines required secrets and Node runtime |
| Update published workflow example | `.github/workflows/code-review.yml` | PR trigger + permissions + action usage |
| Update build/release mechanics | `package.json`, `CONTRIBUTING.md` | `ncc` bundling and tag-driven releases |
| Understand external usage contract | `README.md` | Inputs and setup expectations |

## CODE MAP
| Symbol | Type | Location | Refs | Role |
|--------|------|----------|------|------|
| `run` | function | `src/index.js` | n/a | Main flow: validate context, gather diff, call Z.ai, post/update PR comment |
| `getChangedFiles` | function | `src/index.js` | n/a | Fetch changed PR files via Octokit |
| `buildPrompt` | function | `src/index.js` | n/a | Convert file patches into prompt text |
| `callZaiApi` | function | `src/index.js` | n/a | HTTPS call to Z.ai chat completions |
| `run().catch(...)` | invocation | `src/index.js` | n/a | Terminal error-to-`core.setFailed` bridge |

## CONVENTIONS
- Source of truth is `src/index.js`; do not implement behavior changes directly in `dist/`.
- After source edits, run `npm run build` to regenerate `dist/index.js` and `dist/licenses.txt`.
- Commit regenerated `dist/` artifacts with source changes because GitHub executes `dist/index.js` directly.
- Keep PR scope narrow (one fix/feature) per contribution guidance.

## ANTI-PATTERNS (THIS PROJECT)
- Editing `dist/index.js` manually.
- Shipping source changes without rebuilding and committing `dist/`.
- Treating workflow example or roadmap doc as runtime logic source.
- Assuming tests exist; there is no project test suite or `npm test` script.

## UNIQUE STYLES
- Single-file runtime architecture keeps all operational logic in one module (`src/index.js`).
- Comment updates are idempotent via marker-based find-and-update behavior in PR threads.
- Minimal-toolchain repo: plain JS + `@vercel/ncc`, no lint/test/typecheck config.

## COMMANDS
```bash
npm install
npm run build
```

## NOTES
- Current line concentration is generated code: `dist/index.js` (~31974 lines), `dist/licenses.txt` (~588).
- Maintained logic footprint is small: `src/index.js` (~135 lines).
- `ZAI-BOT-FEATURES.md` is roadmap context, not implemented behavior.
