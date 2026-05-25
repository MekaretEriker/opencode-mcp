# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Fork notation: entries tagged `[upstream]` were cherry-picked or carried forward from
[AlaeddineMessadi/opencode-mcp](https://github.com/AlaeddineMessadi/opencode-mcp).
Entries tagged `[fork]` are specific to `@mekareteriker/opencode-mcp`.

## [1.14.0-mekareteriker.0] - 2026-05-25

### Added

- `[fork]` **#39 — `opencode_write_file` tool: file-first wrapper that bypasses the upstream `write` tool stall.** The native opencode `write` tool stalls indefinitely on prose/markdown payloads containing backticks, em-dashes, accented characters, or fenced code blocks when dispatched through DeepSeek/OpenRouter (`deepseek-v4-pro`, `deepseek-v4-flash` both reproduced — see issue body for full repro). The bug is upstream OpenCode (`packages/opencode/src/tool/write.ts` — buffer the entire streamed `content` argument before materialization, AND the JSON stream never closes properly on certain payloads), but the symptom surfaces through our wrapper because we expose `session/shell` as our only escape hatch.

  **New tool:** `opencode_write_file({ sessionId, path, content, agent, providerID?, modelID?, variant?, directory? })`.

  **How it works:**
  - Content is base64-encoded in Node (via `Buffer.from(content, "utf8").toString("base64")`) — never enters the LLM tool-call stream.
  - The wrapper composes `printf '%s' '<BASE64>' | base64 -d > <quoted-path>` and dispatches via `session.session.shell()`.
  - The composed command contains zero unescaped backticks, so it passes the `SHELL_CONTENT_REFUSED` guard from #25/#28.
  - The file path is single-quoted with POSIX close-escape-reopen (the 4-char sequence `'\''`), so paths with spaces, apostrophes, or parens all work.
  - `printf '%s'` is preferred over `echo` because POSIX `echo` behavior with backslash sequences is implementation-defined.

  **Why this is the right shape (not a session-side SDK route):** the opencode SDK (`@opencode-ai/sdk@1.15.3`) does NOT expose `session.file.write` or any equivalent direct-write route. `session.shell` is the only documented surface that materializes server-side state, and it is already battle-tested in `opencode_shell_execute`. The base64 round-trip is the same workaround Relkhon was applying by hand at the Cowork orchestration layer — sedimenting it into the wrapper eliminates the repeat-yourself tax.

  **Cross-reference with Hermes:** `zaycruz/hermes-opencode-plugin` does not implement a similar workaround because it sidesteps the bug by architecture (Hermes keeps small file writes on its own side via native `terminal` / `read_file` tools, never delegating prose-heavy writes to OpenCode). Our wrapper lives in a different position in the stack — Cowork has no equivalent of Hermes's `terminal` tool — so the workaround needs to be a first-class MCP tool here.

  **Helper extraction:** the encoding + quoting logic lives in `composeWriteFileCommand(filePath, content)` in `helpers.ts`, exported for unit testing in isolation from SDK / network. Tests (`tests/helpers.test.ts`) cover: Unicode round-trip on the exact issue #39 payload, CJK + emoji + combining marks + RTL stress test, backtick-free guarantee on the generated command, single-quote escaping in paths, paths with spaces/parens, empty content, and base64-alphabet-only output.

  **Usage from Cowork / skills:** prefer `opencode_write_file` over delegating to the LLM's native `write` tool whenever the content is prose/markdown ≥ 30 lines OR contains any of: backticks, em-dashes, accented characters, fenced code blocks. The downstream `opencode-agent` skill update teaches the orchestrator to make that choice automatically (see opencode-agent CHANGELOG for the matching minor bump).

  **Tests:** `tests/helpers.test.ts` adds the `describe("Issue #39 — composeWriteFileCommand (opencode_write_file)")` block with 8 tests covering encoding, escaping, and shell-safety properties. Full suite: **383 passed / 11 skipped / 0 failed across 7 files** (was 375 from #33). Net +8 from #39's 8 new tests.

  Closes #39.

## [1.13.0-mekareteriker.0] - 2026-05-22

### Fixed

- `[fork]` **#33 — Cross-OS directory resolution: POSIX-only paths fail on Windows client + Linux server.** On a Windows Cowork client targeting a Linux/WSL OpenCode server, passing a POSIX-only path (e.g. `/home/user/project`, `/root/foo`, `/tmp/bar`) to any MCP tool's `directory` parameter would fail with `Directory not found: "C:\home\user\project" does not exist.` because `normalizeDirectory()` passed the path through `path.resolve()` under Windows semantics, where the leading `/` is interpreted as "current drive root" — producing `C:\home\...` which never exists on Windows. `/mnt/<drive>/...` paths worked by accident because `wslToWindowsPath` translated them to `<drive>:\...` which *does* exist.

  **Fix**:
  - **Shape-driven cross-OS resolution** in `normalizeDirectory()`: if the client is Windows and the input starts with `/` but doesn't match `/mnt/<drive>/`, skip local `existsSync` validation and ship the path verbatim to the server. The server will return a clear "no such directory" error if the path is invalid — strictly better than the current cryptic `C:\home\...` error.
  - **`OPENCODE_MCP_SERVER_OS=linux|win32|darwin|auto`** env var (default `auto`) as an escape hatch for the symmetric case (Linux client + Windows server). When set to `win32` on a Linux client, Windows drive-letter paths skip `existsSync` and ship verbatim. When set to `linux` or `darwin`, same as `auto` for the Windows-client side.
  - **`getServerOsHint()`** private helper reads the env var, validates against allowed values, defaults to `auto`.
  - **All existing behavior preserved**: Windows-on-Windows, WSL-mount translation (`/mnt/<drive>/...`), `OPENCODE_MCP_TRANSLATE_PATHS`.

  | input shape | client OS | server OS hint | action |
  |---|---|---|---|
  | `C:\Users\...` | win32 | auto / linux / darwin | local validation + translation (unchanged) |
  | `/mnt/<d>/...` | win32 | auto / linux / darwin | wslToWindowsPath → local validation (unchanged) |
  | `/home/...`, `/root/...`, `/tmp/...` | win32 | auto / linux / darwin | skip local validation, ship verbatim to server |
  | any | non-win32 | auto | local validation (unchanged) |
  | `C:\Users\...` | non-win32 | win32 | skip local validation, ship verbatim |

  **Tests** (`tests/helpers.test.ts`):
  - New `describe("normalizeDirectory — cross-OS (Windows client + Linux server)")` block with 8 tests:
    - 3 Windows-only (`it.runIf`) tests: `/home/`, `/root/`, `/tmp/` return verbatim.
    - 1 Windows-only regression guard: `/mnt/z/...` still throws when the Windows form doesn't exist.
    - 1 Linux test: non-existent POSIX path still throws (unchanged behavior).
    - 1 Windows-only test: `OPENCODE_MCP_SERVER_OS=linux` confirmation.
    - 1 Windows-only test: `OPENCODE_MCP_SERVER_OS=darwin` confirmation.
    - 1 Linux test: `OPENCODE_MCP_SERVER_OS=win32` ships `C:\Users\foo` verbatim.
  - Full suite: **375 passed / 11 skipped / 0 failed across 7 files** (was 370 from #26). Net +8 from #33's 8 new tests (2 run on Linux, 6 gated for Windows CI).

  See [issue #33](https://github.com/MekaretEriker/opencode-mcp/issues/33).

## [1.12.2-mekareteriker.0] - 2026-05-18

### Fixed

- `[fork]` **#26 — `EMPTY_RESPONSE` now fires on zero-content assistant message (out-of-roster OpenRouter silent-fail).** Before this release, `opencode_run` / `opencode_run_streaming` / `opencode_ask` / `opencode_reply` / `opencode_message_send` would all return a clean `toolResult` labelled `Status: completed` when the session reached idle with an empty assistant message — no error surfaced, no structured-error block emitted. Out-of-roster OpenRouter dispatches (e.g. `anthropic/claude-sonnet-latest` when the operator's `OPENROUTER-MODELS.md` excludes it) and free-tier models under load (`qwen/qwen3-coder:free`, etc.) silently produced this state. Downstream `opencode-fallback-chain` could not trigger fallback because the wrapper never signalled the failure.

  Witnessed directly while writing this fix: during the same Cowork session that produced the #27 patch, **three consecutive `opencode_fire` dispatches** (claude-sonnet-4.5, claude-opus-4.5, deepseek-chat-v3.1 — three providers, three models) all returned the documented "(no content)" silent-success — the orchestrator was forced to abandon OpenCode dispatch entirely and fall back to direct file edits. That outcome is the canonical failure mode this fix closes.

  **Fix**:
  - **`EmptyResponseError` class** exported from `src/helpers.ts` — typed `Error` subclass carrying `code: "EMPTY_RESPONSE"`. Same pattern as `ShellContentRefusedError` from #28: typed errors win over message-pattern classification in `buildStructuredError` via an `instanceof` fast-path.
  - **`buildStructuredError` branch**: `instanceof EmptyResponseError` checked before any HTTP-status / message-pattern branch. The pre-existing `lower.includes("no text content") || lower.includes("empty response")` pattern-matcher is preserved as a fallback for any code that still throws plain `Error` with those wordings (older callers, third-party tools).
  - **Five callsites patched** to throw `EmptyResponseError` (caught by their `try/catch` → `toolError(e, ctx)` → structured-error block with `code: "EMPTY_RESPONSE"`):
    - `src/tools/workflow.ts` — `opencode_ask` (the v1.1.0-era `analyzeMessageResponse(response).isEmpty` branch now throws instead of appending `--- WARNING ---` text);
    - `src/tools/workflow.ts` — `opencode_reply` (same);
    - `src/tools/workflow.ts` — `opencode_run` (NEW: the polling path at `status === "idle" || status === "completed"` now calls `analyzeMessageResponse` on the last message before reporting success — this is the headline bug from the issue);
    - `src/tools/workflow.ts` — `opencode_run_streaming` (NEW: after `session.idle` fires, the post-fetch message list is checked for empty content);
    - `src/tools/message.ts` — `opencode_message_send` (same as ask/reply).
  - **`responseParts` ctx** is forwarded to `toolError` at each site so the structured-error block carries `tokenUsage` extracted from the `step-finish` part — the operator can see "input: 256, completion: 0" and immediately diagnose "LLM was reached but produced nothing" vs "request never landed".

  **Behavioural change for callers**: any code that previously checked for `--- WARNING ---` text in the response on these tools must now check `result.isError === true` and parse the `<!-- structured-error -->` JSON block (or just react to `code: "EMPTY_RESPONSE"` directly). The `opencode-fallback-chain` skill on the Cowork side already maps `EMPTY_RESPONSE → trigger fallback` (documented since opencode-agent v1.1.0), so this is the wire-up that makes that mapping actually fire.

  **Tests** (`tests/helpers.test.ts` + `tests/tools.test.ts`):
  - New `describe("Issue #26 — EMPTY_RESPONSE structured-error code")` block in `helpers.test.ts` with 3 unit tests: classifies typed error, surfaces end-to-end through `toolError` with tokenUsage extraction, typed error wins over decoy `timeout`/`401` message text.
  - 5 pre-existing `tests/tools.test.ts` tests updated from "warns when response is empty" (asserted the old `--- WARNING ---` behaviour) to "surfaces EMPTY_RESPONSE when response is empty/null (issue #26)" (asserts `result.isError === true` and `Error [EMPTY_RESPONSE]` in the human line plus `"code": "EMPTY_RESPONSE"` in the JSON block).
  - Full suite: **373 passed / 5 skipped / 0 failed across 7 files** (was 370 from #28). Net +3 from #26's 3 new unit tests; existing tests preserved minus the 5 renames.

  **Out of scope (per the issue)**: pre-flight model validation against the operator's `OPENROUTER-MODELS.md` roster. That's an orchestrator-side concern (handled by a future skill update or by the planned MEK-286 preflight provider skill in `opencode-agent` backlog #38). This ticket only surfaces empty-content as an error after the fact — the wrapper now behaves correctly regardless of why the session went empty.

  See [issue #26](https://github.com/MekaretEriker/opencode-mcp/issues/26).

### Added

- `[fork]` **#28 — new `SHELL_CONTENT_REFUSED` structured-error code + typed `ShellContentRefusedError` class (polish for #25).** The backtick-refusal path in `opencode_shell_execute` used to throw `new Error("Unescaped backtick…")`, which fell through every classification branch in `buildStructuredError` and surfaced as `code: "UNKNOWN"`. Downstream skills (especially [`opencode-agent`'s `opencode-fallback-chain`](https://github.com/MekaretEriker/opencode-agent-for-cowork/tree/main/skills/opencode-fallback-chain)) treat `UNKNOWN` as "maybe transient, try a fallback provider" — wasting provider quota on a refusal that is *deterministic* (the wrapper rejects before any LLM call ever fires; switching provider would yield the same refusal). This release introduces:
  - **`ShellContentRefusedError` class** exported from `src/helpers.ts` — typed `Error` subclass carrying `code: "SHELL_CONTENT_REFUSED"`. Documented as "the wrapper-level discipline refusal — do NOT retry on a different provider" in JSDoc.
  - **`SHELL_CONTENT_REFUSED` value** added to the `StructuredErrorCode` union.
  - **Classification fast-path** in `buildStructuredError`: `instanceof ShellContentRefusedError` is checked BEFORE any HTTP-status / message-pattern branch (promoted to first position per AGENTS.md's "BEFORE the generic TIMEOUT branch" rule, here taken to its logical extreme — typed errors are unambiguous).
  - **`getSuggestedAction` mapping** with explicit "do NOT retry on a different provider" language and a link to issue #25 explaining the file-first pattern callers should rewrite their command into.
  - **Refusal site updated** in `src/tools/message.ts` to throw `new ShellContentRefusedError(...)` instead of `new Error(...)`. Same error message wording, same regex trigger — only the type changes.

  Acceptance criteria (per issue #28) all satisfied: refusal emits a non-`UNKNOWN` code; new tests in `tests/helpers.test.ts` assert `buildStructuredError(new ShellContentRefusedError(...))` returns `code: "SHELL_CONTENT_REFUSED"` AND that `toolError` surfaces it end-to-end (both the human line `Error [SHELL_CONTENT_REFUSED]: ...` and the JSON in the `<!-- structured-error -->` block). Pre-existing refusal tests in `tests/tools.test.ts` are unchanged and still pass — the refusal text and absence of the downstream POST are unchanged. Full suite: **370 passed / 5 skipped / 0 failed across 7 files** (was 368 from #27). See [issue #28](https://github.com/MekaretEriker/opencode-mcp/issues/28). Companion change in [`opencode-agent`'s `opencode-fallback-chain` skill](https://github.com/MekaretEriker/opencode-agent-for-cowork/blob/main/skills/opencode-fallback-chain/SKILL.md) maps the new code to "do not retry" so downstream callers route the error sensibly.

### Fixed

- `[fork]` **#27 — `opencode_shell_execute` dedup over-application (MEK-284 cache key was not body-aware).** The idempotency layer in `src/sdk-adapter.ts` keyed cache entries on `${method}:${path}:cl=${content-length}` — a cheap content-length proxy that collided whenever two POST bodies happened to serialize to the same length. In practice, this caused:
  1. Two `opencode_shell_execute` POSTs in the same session with different `command` strings of similar length returned the FIRST tool-call's cached Response to the second caller (same `callID`, `messageID`, `prt_*`). The second command was never executed. Observed across multiple sessions during the v1.12.1 release ritual on 2026-05-18 (ses_1c5f96d92ffe3ya84KnK27C5z6 and others) — the operator was forced to chain commands with `&&` and create a fresh session per dispatch as workaround.
  2. Two `session.create` POSTs from clients with different `x-opencode-directory` headers but identical body collided on `(path, content-length)` because the header was not part of the key. The second `session_create` returned the first session's data, mis-attributed to the wrong directory. Observed 2026-05-18 when two parallel `opencode_session_create` calls (one targeting `opencode-mcp`, one targeting `opencode-agent`) returned the same session ID.

  **Fix**: replaced the `idempotencyFingerprint(method, path, headers)` helper with an async, body-aware, directory-aware variant: `idempotencyFingerprint(method, path, directory, bodyText) → SHA-256-keyed string`. The request body is now consumed once early in `customFetch` via `await req.text()` and reused both for the cache key and for the downstream `fetchReq` (passed as a string body, which removes the need for `duplex: "half"`). The new key is `${method}:${path}:dir=${directory}:body=${sha256(body).slice(0,16)}` — collision rate ~10⁻¹⁹ over the 60s dedup window, vs. ~10⁻³ for the old proxy on similarly-shaped JSON bodies. One SHA-256 per POST in customFetch; negligible vs network cost.

  **Regression coverage** (`tests/sdk-adapter.test.ts`):
  - `does NOT dedup two POSTs to the same path with DISTINCT bodies (issue #27)` — pins the shell_execute-style bug (two POSTs to `/session` with titles `"ab"` and `"cd"` — pre-fix would dedup on shared content-length 14; post-fix both reach the network and return distinct session IDs).
  - `does NOT dedup two POSTs with same body but DIFFERENT directories (issue #27 cross-contamination)` — pins the session_create-style bug (two clients with distinct `directory` values both POST `{title:"same"}`; post-fix both reach the network and the responses come back to the correct caller with the correct directory header).
  - All 4 pre-existing dedup tests preserved (parallel-identical dedup still works, GET still bypassed, env-disabled mode still works, reset hook still works). Full suite: **368 passed / 5 skipped / 0 failed across 7 files**.

  See [issue #27](https://github.com/MekaretEriker/opencode-mcp/issues/27) for the full post-mortem and the original Cowork repro. The companion idempotency layer that lives in `src/client.ts` (pre-Phase-C duplicate) is not touched in this fix — it is reachable only when the SDK adapter is bypassed, which is increasingly rare since the Phase C migration in 1.12.0. A follow-up should fold both layers into one shared module.

## [1.12.1-mekareteriker.0] - 2026-05-18

### Changed

- `[fork]` **#25 — `opencode_shell_execute` description rewritten to redirect content-passing to the file-first pattern.** Adopts the discipline-in-tool-description approach used by `NousResearch/hermes-agent` (see `write_file` / `terminal` tool descriptions in their tools reference). The shell tool description now explicitly tells callers to write content to a file via their client's Write tool and reference it with `--body-file` / `--notes-file` / `-F body=@file` / `< file`, rather than inlining content with heredocs or quoted strings. Targets the LLM-driving-shell escape failure mode documented in [`anomalyco/opencode#15810`](https://github.com/anomalyco/opencode/issues/15810) (closed) and [`anthropics/claude-code#29619`](https://github.com/anthropics/claude-code/issues/29619) (closed not-planned). See [issue #25](https://github.com/MekaretEriker/opencode-mcp/issues/25) for the full post-mortem of 6 observed failures across `gh issue close --comment`, `gh release create --notes`, and heredoc-based file writes.

### Added

- `[fork]` **#25 — backtick refusal in `opencode_shell_execute` handler.** Commands containing unescaped backticks (matching `/(?<!\\)`/`) are refused with an instructive error pointing to the file-first pattern. Conservative safety net — has false positives on legitimate `` `hostname` `` uses; workaround is the POSIX `$(hostname)` form. Will be gated behind `OPENCODE_MCP_ALLOW_BACKTICKS=1` env var in a follow-up if false-positive complaints accumulate. Three new tests added in `tests/tools.test.ts`: refusal fires on inlined backticks, clean commands pass through, escaped backticks pass through.

## [1.12.0-mekareteriker.0] - 2026-05-17

### Added

- `[fork]` **MEK-296 — SDK adapter layer (Phase B: foundation).**
  Installed `@opencode-ai/sdk@1.15.3` (auto-generated from opencode server OpenAPI spec,
  type-safe client). Created `src/sdk-adapter.ts` with `createCoworkClient(opts)` factory
  that wraps the official SDK client with Cowork-specific extensions: `x-opencode-directory`
  header injection via `normalizeDirectory()` (MEK-289), idempotency dedup for POST/PUT/PATCH
  (MEK-284), retry policy with method/path-aware fast-fail (MEK-281), lazy server
  reconnection (MEK-280), and structured `OpenCodeError` classification (MEK-282).
  Created `src/types.ts` re-exporting the most-used SDK types (`Session`, `Message`,
  `Part`, `Agent`, `Project`, `Config`, etc.) for Phase C consumption. Neither
  `OpenCodeClient` nor any existing tool was modified — baseline test suite preserved
  plus 17 new sdk-adapter tests (final: 363 passed, 5 skipped, 0 failed).

  **Dedup design fix during implementation review.** The first draft of the
  idempotency layer stored a single `Promise<Response>` in the cache and returned it
  directly to both the original and the deduped callers. Both callers shared the same
  `Response` instance, so the second caller's body read failed with
  *"Body is unusable: Body has already been read"*. Initial diagnostic blamed
  `node:undici` and the SDK's internal request handling, and proposed dropping three
  multi-POST idempotency tests as a workaround. Re-investigation reproduced the bug
  in a minimal probe (`fetch called 1 time, result 2 rejected with Body is unusable`),
  isolating the cause to `Response`-body-consumed-twice rather than any SDK bug.
  Fix: clone the cached `Response` on every return (`existing.promise.then((r) => r.clone())`
  on dedup hit, and `promise.then((r) => r.clone())` for the first caller so the
  in-cache `Response` stays pristine for subsequent dedupped callers). The three
  multi-POST tests are restored and pass. This validates the broader MEK-294/295
  lesson: when a symptom points at an external bug, reproduce it in isolation
  before accepting the workaround. See AGENTS.md "Source of truth" for the rule.

### Changed

- `[fork]` **MEK-297 — Phase C: migrate all `tools/*.ts` from hand-rolled HTTP to typed SDK methods.**
  All 9 tool files (~67 tools total) now use the typed `@opencode-ai/sdk` client
  via a per-directory `sdkFactory` cache plumbed through `src/index.ts`. Each
  handler resolves `const sdk = sdkFactory?.(directory)` at the top, then uses
  `sdk ? sdk.x(...) : client.x(...)` branches. The legacy `OpenCodeClient` is
  kept as fallback when `sdkFactory` is undefined (tests, legacy consumers calling
  `registerXxxTools` with 2 args). Strategy B chosen over Strategy A (façade on
  `OpenCodeClient`): zero changes to `client.ts`, zero changes to tests, baseline
  363 passed / 5 skipped / 0 failed preserved at every commit.

  **Per-directory factory cache (`Map<string, OpencodeClient>`)** preserves the
  MEK-289 per-call `directory` propagation in production. Without it, the
  baked-at-construction `normalizedDirectory` in `createCoworkClient`'s closure
  would silently drop the per-call `directory` parameter for multi-project
  deployments. Module-scoped idempotency map in `sdk-adapter.ts` ensures dedup
  still works across all cached clients.

  **9 granular commits**, one per file, each closing a dedicated GitHub issue:
  - `2c1d2ef` workflow.ts (14 tools)  — #15
  - `13b0e28` message.ts (6 tools)    — #16
  - `c66296e` session.ts (20 tools)   — #17
  - `db21c52` file.ts (6 tools)       — #18
  - `0cee235` project.ts (2 tools)    — #19
  - `36de1af` config.ts (3 tools)     — #20
  - `17fe748` provider.ts (6 tools)   — #21
  - `eb39dd6` tui.ts (9 tools)        — #22
  - `5a80bc4` events.ts (1 tool)      — #23

  **3 SDK gaps documented in-code** (kept raw `client.x()` with explanatory comment):
  - `client.get("/global/health")` in `workflow.ts:opencode_setup` and
    `workflow.ts:opencode_status` — `sdk.global.health()` not in v1
    `@opencode-ai/sdk`'s `Global` class (only `event()`); `health()` exists only
    in the unreleased `@opencode-ai/sdk/v2`.
  - `AbortSignal` handling for SSE in `workflow.ts:opencode_run_streaming` and
    `events.ts:opencode_events_poll` — `sdk.event.subscribe()` returns
    `{stream: AsyncGenerator<Event>}` with no abort hook; replaced
    `controller.signal` pattern with `Promise.race` against the remaining
    timeout deadline. Streaming preserves the load-bearing subscribe-FIRST,
    drain-first-event-without-reopen contract from commit `53aa725`.
  - `client.post("/provider/{id}/oauth/callback")` in `provider.ts` —
    `sdk.provider.oauth.callback()` only exposes `{code?: string}` in its
    typed body, but the legacy endpoint accepts arbitrary
    `Record<string, unknown>`; the wider shape is required by some providers.

  **SDK quirk noted**: `sdk.postSessionIdPermissionsPermissionId()` is
  auto-named by the SDK code generator due to a missing OpenAPI `tags`
  field on that operation. Kept verbatim in `session.ts` since the typed
  signature still provides type safety; an upstream fix to the OpenAPI spec
  would rename it to `sdk.session.permission.respond()` or similar.

  **MCP tool surface is unchanged** — all zod schemas, parameter names,
  response formats, and error structures (`toolResult` / `toolError`,
  structured error codes) are identical to pre-Phase-C. Consumers
  (Cowork's `opencode-agent` plugin, Cline, Hermes, custom scripts) need no
  code changes; only the `.mcp.json` range bump from `^1.11.2-mekareteriker.0`
  to `^1.12.0-mekareteriker.0` is required (caret + prerelease semver gotcha
  documented in both repos' `CLAUDE.md`).

  **`OpenCodeClient` post-Phase-C status**: kept fully functional. It is no
  longer the primary path in production (the SDK branch is taken when
  `sdkFactory` is provided), but it remains the fallback for the existing
  test harness and any consumer still calling `registerXxxTools(server, client)`
  with 2 args. A follow-up may mark it `@deprecated` and migrate the test
  harness once the SDK path is exercised in real Cowork deployments.

  Tests at every commit: 363 passed, 5 skipped, 0 failed across 7 files.
  `tsc --noEmit`: 0 errors at every commit.

  Legacy Linear: MEK-297. Closes #15-#23.

## [1.11.2-mekareteriker.0] - 2026-05-17

### Fixed

- `[fork]` **MEK-295 — Hotfix `opencode_run_streaming` SSE ordering + endpoint canonique async.**
  v1.11.1 (MEK-294) avait corrigé le bug d'endpoint en switchant `/prompt` → `/message`, mais
  `/message` est **synchrone** (bloque jusqu'à fin de l'agent loop) — donc dans
  `workflow.ts` la subscription SSE après le `await client.post(...)` se faisait
  systématiquement APRÈS l'émission de `session.idle`. Résultat : le LLM exécutait, la
  session générait un assistant message non-vide, mais le tool retournait `SESSION_HANG`
  après `maxDurationSeconds`. Reproduit en live le 2026-05-17 (session
  `ses_1c9e6dbe9ffexqep0ApCY1RUCl` : Δ Created → Updated = 2.57s mais SESSION_HANG après 60s).
  - Fix endpoint : `POST /session/{sid}/message` → `POST /session/{sid}/prompt_async`.
    C'est l'endpoint canonique async sur opencode 1.14.50 — il retourne 204 immédiatement
    et émet les SSE events pour progression + completion. Documenté dans la doc SDK
    officielle et déjà utilisé par `opencode_message_send_async` dans le même repo
    (l'incohérence était uniquement dans `workflow.ts`).
  - Fix ordering : la subscription SSE (`/event` global) est maintenant **ouverte avant**
    le POST. Le pattern reproduit ce que fait le SDK officiel via `client.event.subscribe()` :
    fetch en vol → POST → consume events filtrés par `sessionID`. Le per-session
    `/session/{sid}/event` (pas dans le SDK, source de bugs first-event-loss historiques —
    cf. commit 53aa725) est retiré.
  - Tests : nouveau test d'ordering (`MEK-295 ordering guard`) qui asserte que
    `subscribeSSE` est appelé avant `post:/prompt_async` — catch toute régression future.
    Test "fallback to /event when /session/{id}/event returns HTML" supprimé (n'a plus
    de sens, on n'utilise plus le per-session). 346 passed, 5 skipped baseline préservé.
  - **Règle de process** : nouvelle section "Source of truth — opencode SDK first, Hermes
    reference second" ajoutée à `AGENTS.md`. Avant toute nouvelle route HTTP ou pattern
    SSE, on consulte le SDK `@opencode-ai/sdk` + l'écosystème Hermes. Plus jamais
    d'invention d'endpoint depuis la training data.

## [1.11.1-mekareteriker.0] - 2026-05-17

### Fixed

- `[fork]` **MEK-294 — Hotfix `opencode_run_streaming` endpoint cassé.**
  v1.11.0-mekareteriker.0 a shipped `opencode_run_streaming` (MEK-283) avec un POST
  sur `/session/{sid}/prompt`. Sur opencode server 1.14.50, cet endpoint est accepté
  silencieusement (200 OK) mais ne déclenche **aucune exécution LLM** — la session
  est créée, reste vierge (Updated == Created, 0 user message, 0 assistant message),
  puis remonte un `SESSION_HANG` au bout de `maxDurationSeconds`. Confirmé en e2e
  le 2026-05-17 avec 3 modèles distincts.
  - Fix : switch `POST /session/{sid}/prompt` → `POST /session/{sid}/message` dans
    `src/tools/workflow.ts` (la registration de `opencode_run_streaming`). `/message`
    est l'endpoint canonique déjà utilisé par `opencode_run` et avéré fonctionnel.
  - Tests : `tests/tools.test.ts` describe `opencode_run_streaming` (4 tests) — les
    mocks `post` matchent maintenant `/message` au lieu de `/prompt`. Baseline
    préservée : 346 passed, 5 skipped, 0 failed.
  - Pourquoi les unit tests n'ont pas attrapé le bug : mock pitfall documenté dans
    `AGENTS.md` — `subscribeSSE` yieldait `session.idle` peu importe l'endpoint POST
    appelé. Un mock qui yield des events ne valide PAS que le serveur accepte
    l'endpoint POST. Validation manuelle en live ajoutée à la procédure release.

## [1.11.0-mekareteriker.0] - 2026-05-17

### Fixed

- `[fork]` **MEK-282 — Structured error surfacing for downstream consumers.**
  `toolError(e, ctx?)` now emits BOTH a human-readable line AND a machine-parsable JSON
  payload embedded in an HTML comment (`<!-- structured-error ... -->`), MCP-compliant
  (still a single `content[]` text part). Downstream clients (Cowork, other LLM wrappers)
  can `JSON.parse` the block to decide how to retry / escalate without regex-matching the
  error string. Symptom in the wild: a 429 from OpenRouter would surface as a vague
  `Error: Rate limit exceeded` with no body / rate-limit headers / retry_after / effective
  model — all of which `OpenCodeError` already had on hand but `toolError` was throwing
  away. With this fix, every error now exposes a `StructuredError` with `code`, `raw.body`,
  `raw.bodyJson`, `provider`, `modelIdRequested`, `tokenUsage`, `sessionId`, and a
  per-code `suggestedAction`.
  - New types: `StructuredError`, `StructuredErrorCode` (8 codes: `EMPTY_RESPONSE`,
    `PROVIDER_ERROR`, `TIMEOUT`, `SESSION_HANG`, `AUTH_FAILED`, `RATE_LIMITED`,
    `INVALID_DIRECTORY`, `UNKNOWN`), `ErrorContext`.
  - New helpers: `buildStructuredError(e, ctx?)`, `formatErrorHuman(structured)`,
    `extractTokenUsage(parts)`, `extractModelIdEffective(parts)`,
    `getSuggestedAction(code, message?)`, `diagnoseUnknownSuggestion(message)`.
  - Classification: `OpenCodeError` → status-based (401/403 → `AUTH_FAILED`, 429 →
    `RATE_LIMITED`, 5xx → `PROVIDER_ERROR`); other `Error` → regex on message (timeout,
    empty response, invalid directory, auth, rate limit) with `UNKNOWN` fallback.
  - `raw.body` is shipped as-is plus a best-effort `bodyJson` via silent `JSON.parse`.
  - `redactSecrets` is applied to the full structured payload BEFORE serialisation, so any
    tokens leaked by a provider in `raw.body` / `raw.headers` are redacted in the JSON
    block (the human-readable line never includes `raw.body` at all).
  - Ctx threading: `{ providerID, modelID, sessionId, responseParts? }` is OPTIONAL. The
    ~75 file-ops / TUI / setup call sites still call `toolError(e)` and keep emitting a
    valid structured block with the ctx fields undefined.
  - 8 prompt-dispatch call sites now thread ctx end-to-end:
    `src/tools/message.ts` × 4 (`opencode_message_send`, `opencode_message_send_async`,
    `opencode_command_execute`, `opencode_shell_execute`) and `src/tools/workflow.ts` × 4
    (`opencode_ask`, `opencode_reply`, `opencode_run`, `opencode_fire`). For
    session-creating tools (`ask` / `run` / `fire`), `sessionId` is declared above the
    `try` block so the catch sees it even if the error fires before session creation.
  - `analyzeMessageResponse` now exposes `tokenUsage?` and `modelIdEffective?` (OPTIONAL,
    backward compatible). Extracted from `step-finish` parts (input → `tokenUsage.prompt`,
    output → `tokenUsage.completion`, reasoning → `tokenUsage.reasoning`).
  - Removed the now-obsolete `diagnoseError(msg)` regex-tip generator; its patterns are
    preserved in `diagnoseUnknownSuggestion` for the `UNKNOWN` code path so behavior is
    unchanged for unclassified errors.
  - 2 new regression tests in `tests/helpers.test.ts` (429 OpenCodeError → full structured
    block, empty response → tokenUsage extraction). Existing `toolError` tests adapted to
    the new `Error [CODE]: msg` format.

- `[fork]` **MEK-289 — WSL ↔ Windows path translation for cross-platform dispatch.**
  `normalizeDirectory` (`src/helpers.ts`) now translates between Windows and WSL path forms
  so the OpenCode server (typically running under WSL/Linux) actually receives a path it can
  use as cwd when the wrapper runs on Windows (typical Cowork deployment shape). Previously
  the validated Windows path was shipped as-is in the `x-opencode-directory` header where the
  Linux server would `path.join(serverCwd, "D:\Projects\...")` producing nonsense like
  `/mnt/d/Projects/agent/D:\Projects\opencode-mcp` — every subsequent `read`/`bash`/`write`
  silent-failed, with `cost: $0.0000` because the session aborted before the model call in
  some cases. Symptom in the wild: empty assistant responses on any dispatch involving tool
  use. Reproduced during the MEK-282 dogfood on 2026-05-16.
  - New `windowsToWslPath()` / `wslToWindowsPath()` pure helpers (no I/O).
  - New env `OPENCODE_MCP_TRANSLATE_PATHS=wsl|none|auto` (default `auto` = translate iff
    `process.platform === "win32"`).
  - `normalizeDirectory` now also accepts WSL-style input (`/mnt/d/...`) on Windows clients
    by translating to Windows form for local `existsSync` validation, so both shapes work.
  - 14 new tests in `tests/helpers.test.ts` (10 for the pure helpers, 4 for translation
    behavior — the 4 windows-only ones skip on POSIX runners).
  - Existing `normalizeDirectory` tests now pin `OPENCODE_MCP_TRANSLATE_PATHS=none` via
    `beforeEach` to assert legacy validation-only behavior.

### Added

- `[fork]` **MEK-283 — `opencode_run_streaming`: SSE-backed run tool (minor bump = new public tool).**
  New workflow tool that mirrors `opencode_run` but consumes the OpenCode server's
  `text/event-stream` instead of polling `/session/{id}` every 3s. Returns when
  `session.idle` fires for the target session. Emits MCP `notifications/progress`
  to the client iff a `progressToken` was passed in the call params
  (per [MCP progress spec](https://spec.modelcontextprotocol.io/specification/server/utilities/progress/));
  otherwise silently waits — backward-compat preserved for clients without progress support.
  - Canonical POST endpoint is `/session/{id}/prompt` (not `/message`), aligned with the OpenCode SDK.
  - SSE strategy: try per-session `/session/{id}/event` first, fall back to global `/event` with
    server-side `sessionID` filtering when per-session returns HTML (e.g. SPA fallback). Probe uses
    `iter.next()` + `Promise.race` against a 500ms timeout so a silent stream falls back fast
    without losing the first event (single connection per path — the probed event is forwarded
    to the main loop).
  - Workaround for [opencode issue #3815](https://github.com/anomalyco/opencode/issues/3815):
    after `session.idle`, re-fetch `GET /session/{id}` to confirm the idle state isn't racy.
  - On timeout without `session.idle`, returns the new structured error code `SESSION_HANG`
    (MEK-282) with the sessionId for debugging — no destructive retry (MEK-281). Mapped in
    `buildStructuredError` from the message pattern `did not emit session.idle within Xs`.
  - Bonus latent fix: `subscribeSSE` now forwards the `directory` header, so multi-project
    Cowork deployments get correctly scoped streams via `events.ts` too.
  - 4 new tests in `tests/tools.test.ts` (happy path, `/event` fallback when per-session returns
    HTML, `SESSION_HANG` on timeout, `sessionID` filtering on `/event`). Total: 346 passed,
    5 skipped, 0 failed.

- `[fork]` **MEK-284 — Idempotency layer for POST/PUT/PATCH.** In-flight or recently-resolved
  non-idempotent requests with identical `(method, path, body)` are deduplicated transparently
  via an in-memory `Map<key, Promise>` (key = `sha256(method:path:body)`, TTL 60s). Eliminates
  the entire class of "duplicate prompt in queue" bugs even if MEK-281 is bypassed, regressed,
  or if another MCP client retries on its own.
  - Configurable via env `OPENCODE_MCP_IDEMPOTENCY_WINDOW_MS` (0 disables).
  - Lazy GC on each insert keeps the map size bounded.
  - Cache the in-flight `Promise<Response>` (not the resolved value) so parallel callers
    all await the same response.
  - `autoServe` reconnection bypasses + invalidates the cache entry for the failed key,
    so retries after server restart get a fresh attempt instead of the cached failure.
  - Exports `_resetIdempotencyMap()` for test isolation.
  - 4 regression tests added in `tests/client.test.ts`.

## [1.10.2-mekareteriker.1] - 2026-05-16

### Fixed

- `[fork]` **MEK-281 — Destructive retry on POST/PUT/PATCH eliminated.** The wrapper's retry loop (`src/client.ts:140-235`) now distinguishes idempotent from non-idempotent HTTP methods. Network errors (AbortError, ECONNRESET, fetch failed, etc.) and transient HTTP errors (429/502/503/504) on POST/PUT/PATCH no longer trigger automatic retries — the server may have already received and processed the request, and retrying would create duplicate state (e.g. duplicate user messages in an OpenCode session queue, which is the observed "4 copies of the same prompt" symptom).
  - New `SAFE_TO_RETRY_METHODS = {GET, HEAD, OPTIONS, DELETE}` set.
  - New `UNSAFE_RETRY_PATHS` regex list blacklisting `/session/.../message` and `/session/.../prompt_async` even for safe methods (defense-in-depth).
  - New `isSafeToRetry(method, path)` helper applied to both the transient-HTTP-error branch and the network/abort-error branch of the retry loop.
  - 4 regression tests added in `tests/client.test.ts`.

### Patches pending upstream

- This is fork-only. Upstream `AlaeddineMessadi/opencode-mcp` is unmaintained (last release `v1.10.1` 2026-04-10, maintainer unresponsive). No PR submitted.

## [1.10.2-mekareteriker.0] - 2026-05-16

First release of the `@mekareteriker/opencode-mcp` fork. Re-publishes upstream `main` HEAD
(three commits sitting unreleased on master since `v1.10.1`, including the critical
Windows path fix), adds CI matrix for Linux/Windows/macOS, and changes nothing about
the wire protocol or tool surface — drop-in replacement for `opencode-mcp@1.10.1`.

### Fixed

- `[upstream]` Accept Windows absolute paths in `normalizeDirectory` ([upstream commit `e8e6cfe`](https://github.com/AlaeddineMessadi/opencode-mcp/commit/e8e6cfe), [PR #6](https://github.com/AlaeddineMessadi/opencode-mcp/pull/6) by [@samuelgudi](https://github.com/samuelgudi)). Previously the validator required the resolved path to start with `"/"`, which broke every tool that accepts `directory` on Windows clients. Now uses platform-aware `path.isAbsolute`.

### Added

- `[upstream]` `OPENCODE_SERVE_ARGS` env var for passing custom args to `opencode serve` ([upstream commit `0f1e1f6`](https://github.com/AlaeddineMessadi/opencode-mcp/commit/0f1e1f6), PR #7/#9).
- `[upstream]` `variant` parameter for model selection in tools ([upstream commit `4756a36`](https://github.com/AlaeddineMessadi/opencode-mcp/commit/4756a36), PR #8/#10).
- `[fork]` GitHub Actions CI: matrix `os: [ubuntu-latest, windows-latest, macos-latest]` × `node: [18, 20, 22]`, plus an npm-pack smoke job.
- `[fork]` `release.yml` workflow: publishes to npm on `v*` tag push with provenance.
- `[fork]` `sync-upstream.yml` workflow: daily cron mirrors upstream `main` into `upstream-tracking` branch and opens an issue if new commits land.
- `[fork]` `publishConfig.access: "public"` so the scoped package publishes without an extra `--access` flag.

### Changed

- `[fork]` Package name: `opencode-mcp` → `@mekareteriker/opencode-mcp`.
- `[fork]` `repository`/`homepage`/`bugs` URLs now point at `MekaretEriker/opencode-mcp`.
- `[fork]` `postbuild` script guards `chmod +x` with `|| true` so it doesn't fail on Windows runners (no chmod).
- `[fork]` LICENSE: dual copyright line preserving Alaeddine Messadi's original attribution alongside the fork maintainer's.
- `[fork]` Tests `tests/helpers.test.ts`, `tests/client.test.ts`, `tests/tools.test.ts` — hardcoded `/tmp` replaced by `os.tmpdir()` so the suite is platform-agnostic and Windows CI runner can pass. Addresses the "13 Linux-only failures" called out in upstream commit `e8e6cfe`. See `SPEC-fork.md` §4 patch #5.

### Patches pending upstream

- The `os.tmpdir()` test fix above is fork-only for now. Will submit to upstream as a PR; if merged it drops from the fork on the next rebase.

## [1.10.1] - 2026-04-10

### Changed

- Instruction examples now use discovered/default provider and model values instead of hardcoded Anthropic examples. This avoids steering MCP clients toward unavailable providers and aligns the startup guidance with `opencode_setup`.

### Fixed

- Health checks for authenticated OpenCode servers now propagate HTTP basic auth through the full auto-start path, including startup polling and reconnection flows.
- `ensureServer()` now forwards configured server credentials during startup so remote protected servers no longer fail the health probe while coming online.

### Stats

- Tool count: 79
- Tests: 320

## [1.10.0] - 2026-02-10

### Added

- **`opencode_permission_list` tool** — lists all pending permission requests across sessions, showing permission type, session ID, patterns, and tool name. Helps detect and unblock sessions stuck waiting for approval in headless mode.
- **`OPENCODE_DEFAULT_PROVIDER` / `OPENCODE_DEFAULT_MODEL` env vars** — set default provider and model for all tool calls. Three-tier resolution: explicit params → env defaults → server fallback. Implemented via `applyModelDefaults()` across all 8 model-accepting tools.
- **`normalizeDirectory()` path validation** — resolves paths to absolute, strips trailing slashes, resolves `..`, and rejects non-existent directories with descriptive errors.
- **Lazy server reconnection** — on `ECONNREFUSED`/`ENOTFOUND` after all retries, auto-restarts the OpenCode server (max 3 reconnection attempts per MCP session).
- **Enhanced `diagnoseError()`** — 6 new error patterns with contextual suggestions (empty response, model errors, permission issues, config problems).
- **Directory display in workflow responses** — `opencode_run`, `opencode_fire`, `opencode_check`, `opencode_status` now show the active project directory.
- **Session-directory consistency warnings** — warns when a session was created for a different directory than the current request.
- **Permissions guidance in instructions** — recommends `"permission": "allow"` in `opencode.json` for headless use, documents permission tools.

### Changed

- **`opencode_session_permission` updated** — now uses the new API (`POST /permission/{requestID}/reply`) with automatic fallback to the deprecated endpoint. `reply` parameter changed from free string to enum: `"once"` | `"always"` | `"reject"`. Removed the old `remember` parameter.

### Fixed

- **Directory validation errors swallowed by `.catch(() => null)`** — `opencode_status`, `opencode_context`, and `opencode_check` used `Promise.all` with `.catch(() => null)` which silently ate validation errors (showing "UNREACHABLE" instead of "directory not found"). Fixed by adding early `normalizeDirectory()` before `Promise.all` in all 3 tools.

### Removed

- Demo projects (`projects/snake-game/`, `projects/nextjs-todo-app/`) — these were test artifacts.

### Stats

- Tool count: 79 (up from 78)
- Tests: 316 (up from 275)

## [1.9.0] - 2026-02-10

### Added

- **`opencode_run` workflow tool** — one-call solution for complex tasks: creates a session, sends the prompt, polls until completion, and returns the result with todo progress. Supports `maxDurationSeconds` (default 10 min) and session reuse via `sessionId`.
- **`opencode_fire` workflow tool** — fire-and-forget: creates a session, dispatches the task, and returns immediately with the session ID and monitoring instructions. Best for long-running tasks where you want to do other work in parallel.
- **`opencode_check` workflow tool** — compact progress report for a session: status, todo progress (completed/total), current task, file change count. Much cheaper than `opencode_conversation`. Supports `detailed` mode for last message text.
- Tool count: 78 (up from 75)
- Tests: 275 (up from 267) — 8 new tests covering `opencode_run` (polling, error, session reuse), `opencode_fire` (dispatch, session reuse), and `opencode_check` (progress, completion, detailed mode)

### Changed

- Instructions updated with new Tier 2 tools (`opencode_run`, `opencode_fire`, `opencode_check`) and simplified recommended workflows
- Best-practices prompt updated with new tool selection table

## [1.8.0] - 2026-02-10

### Added

- **`instructions` field** — the MCP server now provides a comprehensive structured guide via the `instructions` option in the `McpServer` constructor. This helps LLM clients understand tool tiers (5 levels from essential to dangerous), recommended workflows, and the async `message_send_async` + `wait` pattern for long tasks.
- **Tool annotations** — all tools now carry MCP `readOnlyHint` / `destructiveHint` annotations so clients can auto-approve safe read-only operations and warn before destructive ones (e.g. `session_delete`, `instance_dispose`)
- **`opencode-best-practices` prompt** — new prompt template (6th prompt) covering setup, provider/model selection, tool selection table, prompt writing tips, monitoring, error recovery, and common pitfalls
- **Honest wake-up documentation** — `opencode_wait` description now explains that most MCP clients do NOT interrupt the LLM for log notifications, and suggests `opencode_session_todo` for monitoring very long tasks

### Changed

- `opencode_instance_dispose` description now includes a WARNING about permanent shutdown
- Prompts: 6 (up from 5)
- Tests: 267 (up from 266)

## [1.6.0] - 2026-02-09

### Fixed

- **Empty message display** — `formatMessageList()` no longer shows blank output for assistant messages that performed tool calls but had no text content. It now shows concise tool action summaries like `Agent performed 3 action(s): Write: /src/App.tsx, Bash: npm install`
- **Session status `[object Object]`** — `opencode_sessions_overview` and `opencode_session_status` now correctly resolve status objects (e.g. `{ state: "running" }`) to readable strings instead of displaying `[object Object]`
- **`opencode_wait` timeout message** — now includes actionable recovery suggestions (`opencode_conversation` to check progress, `opencode_session_abort` to stop) and correctly resolves object-shaped status values during polling
- **`toolError()` contextual suggestions** — common error patterns (401/403 auth, timeout, rate limit, connection refused, session not found) now include helpful follow-up tool suggestions instead of bare error text

### Added

- `resolveSessionStatus()` exported helper in `src/helpers.ts` — normalizes status from string, object (`{ state, status, type }`), or boolean flags into a readable string
- `summarizeToolInput()` helper — extracts the most useful arg (path, command, query, url) from tool input objects for compact display
- `extractCostMeta()` helper — extracts cost/token metadata from `step-finish` message parts
- `diagnoseError()` private helper — pattern-matches common errors and returns contextual suggestions
- 11 new tool handler tests for `opencode_sessions_overview`, `opencode_session_status`, and `opencode_wait` covering object status resolution, timeout messages, and edge cases
- Tests: 266 total (up from 255)

## [1.5.0] - 2026-02-09

### Added

- `opencode_status` workflow tool for a fast health/providers/sessions/VCS dashboard
- `opencode_provider_test` workflow tool to quickly validate a provider/model actually responds (creates a temp session, sends a tiny prompt, cleans up)
- `opencode_session_search` to find sessions by keyword in title (also matches session ID)
- `scripts/mcp-smoke-test.mjs` end-to-end smoke test runner (spawns opencode-mcp over stdio and exercises most tools/workflows against a running OpenCode server)

### Changed

- Provider configuration detection is now shared via `isProviderConfigured()` (used consistently across provider listing and setup workflows)
- Multiple tool outputs are more token-efficient and user-friendly (compact provider list/model listing, session formatting, and warning surfacing)
- Tool count: 75 (up from 72)
- Tests: 255 total

### Fixed

- `opencode_message_send` no longer silently returns empty output for empty responses; it now appends actionable warnings like `opencode_ask`/`opencode_reply`
- `opencode_session_share` / `opencode_session_unshare` now return formatted confirmations instead of raw JSON dumps
- `opencode_events_poll` no longer crashes on timeout when the SSE stream is idle (abort now cancels the stream safely)

## [1.4.0] - 2025-02-09

### Added

- **Auth error detection** — `opencode_ask` and `opencode_reply` now analyze AI responses for signs of failure (empty response, missing text content, error keywords like "unauthorized" or "invalid key") and append a clear `--- WARNING ---` with actionable guidance instead of silently returning nothing
- **`analyzeMessageResponse()` helper** — new diagnostic function in `src/helpers.ts` that detects empty, error, and auth-related response issues
- **Provider probing in `opencode_setup`** — connected providers are now verified with a lightweight "Reply with OK" probe to distinguish between WORKING, CONNECTED BUT NOT RESPONDING (bad API key), and could-not-verify states. Unconfigured providers now show available auth methods.
- **`opencode_provider_models` tool** — new tool to list models for a single provider, replacing the previous approach of dumping all providers and all models in one massive response
- **164 tests** (up from 140) — new tests for `analyzeMessageResponse`, auth warning in ask/reply, provider probe statuses, compact provider list, and per-provider model listing

### Changed

- **`opencode_provider_list` is now compact** — returns only provider names, connection status, and model count (not the full model list). This dramatically reduces token usage for MCP clients. Use `opencode_provider_models` with a provider ID to drill into a specific provider's models.
- Tool count: 72 (up from 71)

## [1.3.0] - 2025-02-08

### Added

- **Auto-serve** — the MCP server now automatically detects whether `opencode serve` is running and starts it as a child process if not. No more manual "start opencode serve" step before using the MCP server.
  - Checks the `/global/health` endpoint on startup
  - Finds the `opencode` binary via `which`/`where`
  - Spawns `opencode serve --port <port>` and polls until healthy
  - Graceful shutdown: kills the managed child process on SIGINT/SIGTERM/exit
  - Clear error messages with install instructions if the binary is not found
- **`OPENCODE_AUTO_SERVE` env var** — set to `"false"` to disable auto-start for users who prefer manual control
- **`src/server-manager.ts` module** — new module with `findBinary()`, `isServerRunning()`, `startServer()`, `stopServer()`, `ensureServer()`
- **140 tests** (up from 117) — 23 new tests for the server manager covering health checks, binary detection, auto-start, error cases, and shutdown

### Changed

- Startup flow in `src/index.ts` now calls `ensureServer()` before connecting the MCP transport
- Updated README: removed manual "start opencode serve" step, added auto-serve documentation, updated env vars table and architecture section

## [1.2.0] - 2025-02-08

### Added

- **Per-tool project directory targeting** — every tool now accepts an optional `directory` parameter that scopes the request to a specific project directory via the `x-opencode-directory` header. This enables working with multiple projects simultaneously from a single MCP connection without restarting the server.
- **`opencode_setup` workflow tool** — new high-level onboarding tool that checks server health, lists provider configuration status, and shows project info. Use it as the first step when starting work.
- **117 tests** (up from 102) — new tests for directory header propagation, `opencode_setup` handler, and `directoryParam` validation

### Changed

- `opencode_find_file` tool: renamed the search-root override parameter from `directory` to `searchDirectory` to avoid collision with t