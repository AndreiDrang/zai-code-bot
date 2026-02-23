# Contributing to Z.ai Code Review

Thank you for your interest in contributing!

## Issues and pull requests

If you have suggestions for improvements, you can contribute by opening an issue. If you'd like to introduce changes to the project, see the instructions below.

## Project structure

```
src/index.js      # Action source code
dist/index.js     # Compiled bundle (used by the runner)
action.yml        # Action metadata and input definitions
```

The action runs from `dist/index.js`, which is a self-contained bundle built from `src/index.js` using [`@vercel/ncc`](https://github.com/vercel/ncc).

## Development setup

**Prerequisites:** Node.js 20+

```bash
git clone https://github.com/tarmojussila/zai-code-review.git
cd zai-code-review
npm install
```

## Making changes

Edit `src/index.js`, then rebuild the bundle:

```bash
npm run build
```

**The `dist/` directory must be committed.** The GitHub Actions runner executes `dist/index.js` directly — it does not run `npm install` or build steps.

## Submitting a pull request

1. Fork the repository and create a branch from `main`
2. Make your changes in `src/index.js`
3. Run `npm run build` and commit both `src/` and `dist/` changes
4. Open a pull request against `main`

Please keep PRs focused — one fix or feature per PR.

## Releases

Releases are tagged using semantic versioning (e.g. `v0.1.1`). After a PR is merged to `main`, a maintainer will tag the release.

Users reference the action by tag in their workflows, so the `dist/index.js` and `action.yml` at the tagged commit are what gets executed.
## Release Process

### Versioning Convention

This project uses [Semantic Versioning](https://semver.org/). Release tags follow the format `vMAJOR.MINOR.PATCH`:

| Version Type | When to Increment | Example |
|--------------|-------------------|---------|
| Patch (x.x.X) | Bug fixes, small improvements | v0.1.0 → v0.1.1 |
| Minor (x.X.0) | New features, backward-compatible | v0.1.0 → v0.2.0 |
| Major (X.0.0) | Breaking changes | v0.1.0 → v1.0.0 |

### Release Steps

1. **Prepare the release:**
   - Ensure all changes are merged to `main`
   - Verify `npm run build` succeeds
   - Confirm `dist/index.js` and `dist/licenses.txt` are up to date

2. **Create the tag:**
   ```bash
   git tag v0.1.1
   git push origin v0.1.1
   ```

3. **Verify the release:**
   - Check GitHub Actions run for the tag
   - Confirm action works with the new version

### Changelog Expectations

Every release should include a changelog entry. Add to the release notes on GitHub:

```
## What's Changed
- Description of change 1
- Description of change 2

**Full Changelog**: https://github.com/tarmojussila/zai-code-review/compare/v0.1.0...v0.1.1
```

For patch releases, summarize bug fixes. For minor releases, list new features. For major releases, document breaking changes.

### Rollback Steps

If a release causes issues:

1. Revert to previous version in user workflows: `v0.1.0` instead of `v0.1.1`
2. Identify the problematic commit
3. Create a fix or revert commit
4. Tag a new patch release

See [RUNBOOK.md](RUNBOOK.md) for detailed rollback procedures.

## Senior Review Checklist

All releases require sign-off from designated reviewers. Use the appropriate checklist based on the change type.

### JavaScript Review Criteria

Reviewer: Senior JavaScript developer

- [ ] Code follows existing patterns in `src/index.js`
- [ ] No blocking operations (use async/await properly)
- [ ] Error handling covers all failure paths
- [ ] No sensitive data logged or exposed
- [ ] Dependencies are minimal and necessary
- [ ] Build succeeds without errors
- [ ] Bundle size is reasonable (run `npm run build` and check output)

### DevOps Review Criteria

Reviewer: DevOps / Platform engineer

- [ ] GitHub Actions workflow syntax is valid
- [ ] Permissions follow principle of least privilege
- [ ] Action runs on correct triggers
- [ ] No secrets exposed in logs or error messages
- [ ] Version tag follows semver format
- [ ] Rollback procedure documented (if needed)
- [ ] Release can be replicated from tagged commit

### DevSecOps Review Criteria

Reviewer: Security-focused reviewer

- [ ] No new dependencies introduce vulnerabilities
- [ ] API keys handled securely (never logged or hardcoded)
- [ ] User input properly sanitized
- [ ] Permission model unchanged or improved
- [ ] Fork PR handling unchanged or improved
- [ ] Rate limiting still enforced
- [ ] Error messages don't leak sensitive information
- [ ] SECURITY.md policies still satisfied

### Approval Process

1. Pull request submitted against `main`
2. All reviewers complete their checklist
3. Any feedback addressed
4. All reviewers approve
5. Merge to `main`
6. Maintainer creates version tag
7. Monitor for issues (see [RUNBOOK.md](RUNBOOK.md))

## Security

For security policies, authorization rules, and permission requirements, see [SECURITY.md](SECURITY.md).

## License

By contributing, you agree that your contributions will be licensed under the [MIT License](LICENSE).
