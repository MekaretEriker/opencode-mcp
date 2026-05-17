# Cowork operational guide — `@mekareteriker/opencode-mcp`

This file documents the **release management, versioning, and issue
tracking conventions** for Claude operating in Cowork mode on this repo.
For engineering invariants of the codebase (SDK rules, SSE patterns,
error handling, testing), see `AGENTS.md`.

## Quick reference — engineering rule that applies to Cowork too

When YOU (Cowork's Claude) write or refactor code in this repo, the
**"Source of truth — opencode SDK first, Hermes reference second"**
rule documented in `AGENTS.md` applies to you exactly like it applies
to OpenCode or any other build agent. Before inventing an HTTP route
or SSE pattern, consult the SDK (https://opencode.ai/docs/sdk.md) and
the wider ecosystem (`zaycruz/hermes-opencode-plugin`, `awesome-opencode`).
History: MEK-294, MEK-295, and the MEK-296 dedup post-mortem all
root-caused to skipping that step. If you don't know whether a route
or method exists, the SDK is the answer — not training data, not
intuition.

## Release workflow

The repo has a GitHub Actions workflow (`.github/workflows/release.yml`) that
auto-publishes to npm with provenance when a tag matching `v*` is pushed. The
local release ritual:

1. **Bump version** in `package.json`. Semver:
   - Minor (`1.10.x` → `1.11.0`) — new public tool, new env var, new exported
     helper. Anything a consumer can call.
   - Patch (`1.10.2` → `1.10.3`) — bug fix, internal refactor, retry policy
     change. Anything transparent.
2. **Move `[Unreleased]` entries** in `CHANGELOG.md` under a dated version
   header (`## [X.Y.Z-mekareteriker.N] - YYYY-MM-DD`). Drop the "Batched
   release covering …" lead-in if present.
3. **Two commits**:
   - `feat(scope): #N — subject` (or `fix`) for the code, where `#N` is the
     GitHub issue number.
   - `chore(release): vX.Y.Z-mekareteriker.N` for the version bump + CHANGELOG.
   The split keeps the release commit isolable and revertable.
4. **Tag and push**:
   ```bash
   git tag vX.Y.Z-mekareteriker.N
   git push origin main
   git push origin vX.Y.Z-mekareteriker.N
   ```
   Do NOT rely on `git push --follow-tags` — it only pushes annotated tags,
   not lightweight ones. Push the tag explicitly or use `git tag -a` upstream.
5. **CI auto-publishes** to npm. Verify with
   `npm view @mekareteriker/opencode-mcp@X.Y.Z-mekareteriker.N version`.

## Semver gotcha: caret + prerelease is strict

The fork uses prerelease tags (`-mekareteriker.N`). npm's caret semantics with
prereleases are **strict**: `^1.10.2-mekareteriker.0` matches other prereleases
of `1.10.2` only — it does NOT match `1.11.0-mekareteriker.0`. Consumers
(`opencode-agent/.mcp.json`, etc.) must explicitly bump their range when a new
minor or major version ships. This caught us during the `opencode-agent v1.0.3
→ v1.1.0` bump — the `.mcp.json` was silently pinned to the old minor.

When bumping minor, ping downstream consumers (currently just `opencode-agent`)
to update their dep range.

## Issue tracking — GitHub Issues + GitHub Projects v2

Issues live on the GitHub repo (`MekaretEriker/opencode-mcp/issues`) and roll up
on the user-level project board:
**https://github.com/users/MekaretEriker/projects/2**.

The sibling `opencode-agent` repo feeds the same board. Both repos tracked
work in Linear under `MEK-XXX` identifiers prior to the migration; historical
references in CHANGELOG entries, skills, and commit history are preserved
as archive — do not rewrite them.

**New work uses GitHub-native conventions:**

- **Issue refs**: `#N` (e.g. `#42`). GitHub auto-links them across the repo
  and renders them as clickable badges in commits, PRs, and the project board.
- **Cross-repo refs**: `MekaretEriker/opencode-agent#N` when you need to
  reference an issue in the sibling repo.
- **Magic keywords for auto-close**: `Closes #N`, `Fixes #N`, or `Resolves #N`
  anywhere in the commit body. GitHub native — works on push to the default
  branch OR on PR merge. No third-party integration to babysit.
- **Bare `#N` mentions** (e.g. `feat(workflow): #42 — subject`) create a link
  but do NOT close the issue. Use the magic verb when you intend a closure.

**Project board automation** (configured in the Project UI, not in this repo):

- New issue opened → auto-added with status `Todo`.
- Issue closed → status auto-moves to `Done`.
- Custom fields (Priority, Phase, Effort) are set on the board, not in the
  issue body. Keep the issue body for engineering context; let the board
  carry the workflow metadata.

**Historical note**: a previous workflow piped commits through Linear's
GitHub integration using `Closes MEK-XXX` keywords. The integration was
unreliable on direct pushes to `main` (tickets stayed in Backlog despite
the keyword) and is no longer in use. If you find a stale `MEK-XXX`
keyword in a recent commit, prefer correcting downstream issues via the
project board directly rather than re-emitting commit traffic.
