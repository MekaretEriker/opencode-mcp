# RUNBOOK — publishing `@mekareteriker/opencode-mcp` and pointing the plugin at it

> Audience: MekaretEriker, on a Windows machine with PowerShell or git-bash. Total time end-to-end: ~30 min, gated on npm 2FA and a one-time GitHub fork.

## 0. Pre-flight (one-time)

You need:

- A GitHub account (`MekaretEriker`) with the right to fork `AlaeddineMessadi/opencode-mcp`. ✅ Already done — the fork creation form is up.
- An npm account that can publish under the `@mekareteriker` scope. If you don't have one:
  ```bash
  npm adduser   # or `npm login`
  ```
  Scoped packages on a personal account publish automatically as public when `publishConfig.access: public` is set (already in `package.json`). No need for `npm org create`.
- Node ≥18 locally (matches `engines.node` in `package.json`).
- `git` locally.

## 1. Clean the scratch `.git` left by the scaffolding

Open PowerShell and remove the half-broken `.git/` folder the sandbox left behind:

```powershell
cd D:\Projects\opencode-mcp
Remove-Item .git -Recurse -Force
```

If `Remove-Item` complains about "in use", close any VS Code window that has the folder open and retry.

## 2. Finish the GitHub fork

You're already on the form. Settings:
- Owner: `MekaretEriker` ✅
- Repository name: `opencode-mcp` ✅
- "Copy the main branch only": **checked** ✅ (we don't need upstream's other branches)
- Click **Create fork**.

You'll land on `https://github.com/MekaretEriker/opencode-mcp` — a vanilla mirror of upstream. We'll overwrite it in §3.

## 3. Initialize the local repo and push

From `D:\Projects\opencode-mcp` in PowerShell:

```powershell
git init -b main
git remote add origin https://github.com/MekaretEriker/opencode-mcp.git
git remote add upstream https://github.com/AlaeddineMessadi/opencode-mcp.git
git add -A
git status   # sanity check: ~44 files, no node_modules/, no dist/
git commit -m "fork: import upstream master @ 4756a36 + MekaretEriker fork scaffolding

- Rename to @mekareteriker/opencode-mcp, bump to 1.10.2-mekareteriker.0
- Add CI matrix (linux/windows/macos x node 18/20/22)
- Add release.yml + sync-upstream.yml workflows
- LICENSE: dual copyright (upstream author + fork maintainer)
- README: fork banner, migration note
- CHANGELOG: 1.10.2-mekareteriker.0 entry"
git push -u origin main --force
```

The `--force` is safe because the GH fork only has upstream's commits and no shared history with our new tree.

Then create the long-lived tracking branch:

```powershell
git fetch upstream
git checkout -B upstream-tracking upstream/main
git push -u origin upstream-tracking
git checkout main
```

## 4. Enable GitHub Actions secrets

In `https://github.com/MekaretEriker/opencode-mcp/settings/secrets/actions` add:

| Name | Value | Used by |
|---|---|---|
| `NPM_TOKEN` | npm "Automation" token from https://www.npmjs.com/settings/mekareteriker/tokens with publish rights | `release.yml` |

`sync-upstream.yml` uses the default `GITHUB_TOKEN` (no extra secret needed).

## 5. Watch the first CI run

Visit `https://github.com/MekaretEriker/opencode-mcp/actions/workflows/ci.yml`. All 9 matrix combinations (linux/windows/macos × node 18/20/22) should pass — the test suite ran clean locally (321 passed, 1 skipped on the Windows-only test which runs on the Windows runner).

If a platform fails (most likely Windows because of hardcoded `/tmp`, `/home` paths in upstream tests), check `SPEC-fork.md` §4 patch #5 for the fix plan.

## 6. Publish to npm

```powershell
git tag v1.10.2-mekareteriker.0
git push origin v1.10.2-mekareteriker.0
```

This triggers `release.yml` which runs `npm publish --provenance --access public` with `NPM_TOKEN`. Watch at `https://github.com/MekaretEriker/opencode-mcp/actions/workflows/release.yml`.

Verify the published package (~2 min after the workflow completes):

```powershell
npm view @mekareteriker/opencode-mcp
```

## 7. Point the Cowork plugin at the fork

In your Cowork plugin's MCP server config:

```diff
 {
   "mcpServers": {
     "opencode": {
       "command": "npx",
-      "args": ["-y", "opencode-mcp"]
+      "args": ["-y", "@mekareteriker/opencode-mcp"]
     }
   }
 }
```

Restart Cowork. The R9 error should disappear — every skill that passes `directory` now works on Windows native.

Smoke test from inside Cowork:

> "Run opencode_mcp_status on D:\Projects\Relkhon_VerticalSlice"

Should return the MCP servers list, not the absolute-path error.

## 8. Retire the R9 workaround in the orchestrator skill

Once §7 is verified, edit `opencode-orchestrator` SKILL.md §5.1 to replace the `cd $path && …` workaround block with:

> The `directory` parameter works natively from `@mekareteriker/opencode-mcp ≥ 1.10.2-mekareteriker.0`. On upstream `opencode-mcp` ≤ 1.10.1, prepend the prompt with `cd /path && …` as a fallback.

Also update `DESIGN-opencode-agent-for-cowork.md` §10 R9: change the status from "open, mitigation skill" to "resolved via `@mekareteriker/opencode-mcp` fork, see `SPEC-fork.md`".

## 9. Ongoing — when upstream releases

The `sync-upstream.yml` workflow opens an issue when upstream `main` has new commits. When that happens:

```powershell
git fetch upstream
git checkout main
git rebase upstream/main           # resolve any conflicts in your fork-specific files
# bump version in package.json:
#   if upstream went 1.10.1 -> 1.11.0, you become 1.11.0-mekareteriker.0
#   if you're just adding a fork patch on the same upstream, you become 1.10.2-mekareteriker.1
git push --force-with-lease origin main
git tag v<new-version>
git push origin v<new-version>     # triggers release.yml
```

If you've upstreamed a patch and upstream merged it, the rebase will silently drop your duplicate commit — no action needed.

## 10. Roll back

If something breaks downstream, pin to a specific older version is one-line:

```diff
-      "args": ["-y", "@mekareteriker/opencode-mcp"]
+      "args": ["-y", "@mekareteriker/opencode-mcp@1.10.2-mekareteriker.0"]
```

Or fall back to upstream entirely:

```diff
-      "args": ["-y", "@mekareteriker/opencode-mcp"]
+      "args": ["-y", "opencode-mcp"]
```

No data migration, no state, just a flag. The two packages are wire-compatible by design.
