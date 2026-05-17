# Agent guidelines — `@mekareteriker/opencode-mcp`

Hardened fork of `opencode-mcp` with cross-platform fixes for Cowork deployments.
See `SPEC-fork.md` for the audit trail of forked changes versus upstream
`AlaeddineMessadi/opencode-mcp`.

This file documents **engineering invariants** that any build agent (OpenCode,
Cowork's Claude, Cline, etc.) must respect when modifying the codebase: SDK
source-of-truth rule, SSE patterns, error handling, testing conventions.

For **operational workflow** (release management, versioning, issue tracking,
CHANGELOG conventions), see `CLAUDE.md` in the same directory. Cowork's Claude
typically drives those workflows; they're kept separate so the engineering
rules stay focused.

## Source of truth — opencode SDK first, Hermes reference second

**Hard rule, no exceptions.** Before adding a new tool, a new HTTP route, or a
new event-consumption pattern, do this in order:

1. **Check the official `@opencode-ai/sdk`** (https://opencode.ai/docs/sdk.md
   and the generated `types.gen.ts`). The SDK is auto-generated from the
   server's OpenAPI spec — if a method isn't in the SDK, the route may not
   exist, may be deprecated, or may have a non-obvious shape. The SDK is the
   single source of truth for what the server actually accepts.
2. **Check how `zaycruz/hermes-opencode-plugin`** (and other notable ecosystem
   consumers listed in `awesome-opencode`) dispatch the same operation. They
   consume the SDK at scale and surface the canonical patterns. If our wrapper
   diverges from what Hermes does, we have a justification burden.
3. **Only then** look at GitHub issues / source code if the SDK is silent or
   ambiguous. Always cite the SDK page or issue number in the code comment
   that documents the choice.

**Anti-patterns explicitly forbidden** — these have all bitten us:

- Inventing an HTTP route from training data or "looks right" intuition. The
  MEK-283 spec said `POST /session/{sid}/prompt` was canonical for an async
  prompt; it was never in the SDK, it never triggered the LLM, and MEK-294
  was the hotfix. **If the SDK doesn't expose it, do not POST to it.**
- Mocking SSE behaviour to validate an HTTP endpoint choice. A `subscribeSSE`
  mock that yields `session.idle` regardless of POST path will pass the test
  while production silently misroutes. Endpoint correctness must be validated
  against a real `opencode serve`, not against mocks. See "Mock pitfall" below.
- Treating `/message` and `/prompt_async` as interchangeable. They are not:
  `POST /session/{sid}/message` is **synchronous** (blocks until the agent
  loop completes, then returns the AssistantMessage — equivalent to
  `client.session.prompt({...})`). `POST /session/{sid}/prompt_async` is
  **fire-and-forget** (returns 204 immediately, emits SSE events for
  progress, requires the caller to consume `event.subscribe()` for
  completion). Use `/message` for one-shot blocking dispatches
  (`opencode_ask`, `opencode_run`). Use `/prompt_async` for streaming
  dispatches (`opencode_run_streaming`, `opencode_message_send_async`).

**Canonical SSE / streaming pattern from the SDK** (mirror this in any new
tool that consumes events):

```ts
// 1. Subscribe FIRST — the connection must be open before any operation
//    that emits events, otherwise the events fire while you're not listening
//    and a fresh subscription only sees events emitted after subscribe time.
const events = await client.event.subscribe()

// 2. Fire the async operation (POST returns 204 immediately)
await client.post(`/session/${sid}/prompt_async`, body)

// 3. Consume the stream until session.idle
for await (const event of events.stream) {
  if (event.type === "session.idle" && event.properties.sessionID === sid) break
  // emit progress, accumulate parts, etc.
}
```

The SDK exposes `client.event.subscribe()` as a long-lived global stream —
one subscription serves all sessions, filter by `sessionID` on the client
side. Do **not** open a per-session `/session/{sid}/event` stream unless
there's a documented reason: it's not in the SDK, it forces reconnection on
every dispatch, and it makes the first-event-loss footgun (documented under
"SSE / streaming pattern" below) significantly more likely.

When the SDK is genuinely insufficient — e.g. the wrapper needs to inject
`x-opencode-directory` for Windows path translation, which the SDK doesn't
expose — wrap the SDK client rather than bypassing it. The fallback to raw
`fetch` should be the **last** option, documented in code with a link to the
SDK gap that motivated it.

## SSE / streaming pattern

`OpenCodeClient.subscribeSSE(path, opts?)` is an async generator yielding
`{event, data}` pairs from a `text/event-stream`. `opts` accepts `signal`
(AbortSignal) and `directory` (forwarded as `x-opencode-directory` header so
multi-project deployments get scoped streams).

The probe pattern in `opencode_run_streaming` (`src/tools/workflow.ts`) is
load-bearing and easy to break:

```ts
// Probe per-session SSE with iter.next() + Promise.race against 500ms timeout.
// If it works, the FIRST EVENT IS CARRIED INTO THE MAIN LOOP — we do NOT
// reopen the stream. Reopening loses the first event because a fresh SSE
// connection only sees events emitted after subscription time.
```

Do not "simplify" this to a `for await` + reconnect. Mocks in `tests/tools.test.ts`
that yield the same event sequence on every `subscribeSSE` call will hide the
regression — the tests pass, production loses every first event (including
`session.idle` on very short tasks, producing a spurious `SESSION_HANG`).

History: bug found in code review of MEK-283 before merge. See commit `53aa725`
for the corrected probe.

## Structured errors (MEK-282)

`toolError(e, ctx?)` returns BOTH a human-readable line AND a machine-parsable
JSON block embedded in an HTML comment. New error codes are added by:

1. Extending `StructuredErrorCode` in `src/helpers.ts`.
2. Adding a classification branch in `buildStructuredError` BEFORE the generic
   `TIMEOUT` branch (otherwise messages with "timeout" win even when more
   specific patterns apply — this caught us on `SESSION_HANG`, which initially
   fell through to `UNKNOWN`).
3. Adding a `suggestedAction` mapping in `getSuggestedAction`.

When you add a new tool that can fail in a structured way, thread the context
through: `toolError(e, { providerID, modelID, sessionId, responseParts })`.
Declare `sessionId` above the `try` block so the catch block sees it even when
the error fires before session creation.

## Testing conventions

- `npx vitest run` — full suite. Baseline at the time of this writing: 346
  passed, 5 skipped, 0 failed across 6 files.
- Mock client: see `createMockClient` in `tests/tools.test.ts`.
- **Mock pitfall**: a `subscribeSSE` mock that yields the same events on every
  invocation does NOT model real SSE behavior. Real SSE delivers each event
  exactly once across the lifetime of the connection. If your code reopens
  the stream, the mock will still see the events but production won't. When
  testing SSE consumers, treat each connection as one-shot.

