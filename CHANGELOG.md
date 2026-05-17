# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Fork notation: entries tagged `[upstream]` were cherry-picked or carried forward from
[AlaeddineMessadi/opencode-mcp](https://github.com/AlaeddineMessadi/opencode-mcp).
Entries tagged `[fork]` are specific to `@mekareteriker/opencode-mcp`.

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