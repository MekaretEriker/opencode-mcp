/**
 * SDK adapter: wraps the official `@opencode-ai/sdk` client with Cowork-specific
 * extensions that the bare SDK does not provide.
 *
 * ## What this layer adds (on top of the SDK)
 *
 * | Capability           | MEK   | Implementation                            |
 * |----------------------|-------|-------------------------------------------|
 * | Directory injection  | 289   | `normalizeDirectory()` → `x-opencode-directory` header |
 * | Idempotency dedup    | 284   | In-memory `Map` of in-flight POST/PUT/PATCH |
 * | Retry policy         | 281   | No retry on non-idempotent methods/paths |
 * | Lazy reconnect       | 280   | Auto-restart server on connection failure |
 * | Structured errors    | 282   | `OpenCodeError` with status classification |
 *
 * ## SDK gaps documented here
 *
 * - **`x-opencode-directory` header not exposed in SDK config**: the SDK's
 *   `createOpencodeClient({ directory })` encodes the path via
 *   `encodeURIComponent()` but does not validate existence or translate
 *   Windows ↔ WSL paths (MEK-289).  We inject the header ourselves in
 *   `customFetch` after running the full `normalizeDirectory()` pipeline.
 *   See SPEC-fork.md § MEK-289.
 *
 * - **No built-in retry/dedup**: the SDK's generated client is a thin wrapper
 *   over the OpenAPI spec — it performs exactly one HTTP call per method
 *   invocation.  Retry, idempotency, and connection recovery are our
 *   responsibility.
 *
 * ## How to use
 *
 * ```ts
 * import { createCoworkClient } from "./sdk-adapter.js";
 * const client = createCoworkClient({
 *   baseUrl: "http://localhost:4096",
 *   directory: "/path/to/project",
 * });
 * // client.session.prompt(...), client.event.subscribe(), etc.
 * ```
 *
 * @module sdk-adapter
 */

import {
  createOpencodeClient,
  type OpencodeClient,
} from "@opencode-ai/sdk/client";
import { normalizeDirectory } from "./helpers.js";
import { ensureServer, isServerRunning } from "./server-manager.js";
import { OpenCodeError } from "./client.js";

// ── Retry-policy helpers (duplicated from src/client.ts) ────────────────
//
// These are private in client.ts.  Phase C will extract them into a shared
// module so both OpenCodeClient and the SDK adapter consume the same logic.
// Duplicating here avoids touching client.ts in Phase B.
//
// See MEK-281 for the full rationale.

const SAFE_TO_RETRY_METHODS = new Set(["GET", "HEAD", "OPTIONS", "DELETE"]);

const UNSAFE_RETRY_PATHS: RegExp[] = [
  /\/session\/[^/]+\/message$/,
  /\/session\/[^/]+\/prompt_async$/,
];

function isSafeToRetry(method: string, path: string): boolean {
  const upper = method.toUpperCase();
  if (!SAFE_TO_RETRY_METHODS.has(upper)) return false;
  if (UNSAFE_RETRY_PATHS.some((re) => re.test(path))) return false;
  return true;
}

// ── Cowork client options ──────────────────────────────────────────────

export interface CoworkClientOptions {
  /** Base URL of the OpenCode server (e.g. http://127.0.0.1:4096). */
  baseUrl: string;
  /** Optional HTTP basic auth username (defaults to "opencode"). */
  username?: string;
  /** HTTP basic auth password. If set, auth header is added to every request. */
  password?: string;
  /** Project directory. Validated & translated via normalizeDirectory(). */
  directory?: string;
  /** Enable lazy server reconnection when connection fails. */
  autoServe?: boolean;
}

// ── MEK-284: Idempotency layer ─────────────────────────────────────────
//
// Dedup transparent des POST/PUT/PATCH identiques en-flight ou récemment
// résolus.  Duplicated from src/client.ts — in Phase C this will be
// unified when OpenCodeClient migrates to use the SDK adapter.
//
// Configurable via env `OPENCODE_MCP_IDEMPOTENCY_WINDOW_MS` (0 disables).

type IdempotencyEntry = {
  promise: Promise<Response>;
  expiresAt: number;
};

const idempotencyMap = new Map<string, IdempotencyEntry>();

const IDEMPOTENCY_WINDOW_MS = (() => {
  const raw = process.env.OPENCODE_MCP_IDEMPOTENCY_WINDOW_MS;
  if (raw === undefined) return 60_000;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : 60_000;
})();

const IDEMPOTENT_METHODS = new Set(["POST", "PUT", "PATCH"]);

/** Test-only: reset the adapter's idempotency map. @internal */
export function _resetSdkIdempotencyMap(): void {
  idempotencyMap.clear();
}

// ── Retry constants ────────────────────────────────────────────────────

const MAX_RETRIES = 2;
const BASE_DELAY_MS = 500;
const MAX_RECONNECT_ATTEMPTS = 3;

// ── Connection-error detection ─────────────────────────────────────────

function isConnectionError(err: Error): boolean {
  const msg = err.message.toLowerCase();
  return (
    msg.includes("econnrefused") ||
    msg.includes("enotfound") ||
    msg.includes("ehostunreach") ||
    msg.includes("fetch failed") ||
    msg.includes("network error") ||
    msg.includes("socket hang up")
  );
}

// ── Request body fingerprint (for idempotency key) ─────────────────────
//
// As of issue #27 (opencode-mcp), we consume the request body once early in
// `customFetch` (see below) to compute a SHA-256 fingerprint instead of
// using the cheap-but-collision-prone (METHOD, PATH, content-length) proxy
// that the original implementation relied on.
//
// The old fingerprint caused two distinct bug classes in production:
//
//   1. Two `opencode_shell_execute` POSTs in the same session with different
//      `command` strings of similar length would collide on content-length,
//      returning the FIRST tool-call's cached Response to the second caller
//      (same `callID`, same `prt_*`).  Documented in issue #27.
//
//   2. Two `session.create` POSTs from clients with different
//      `x-opencode-directory` headers but identical body would collide on
//      (path, content-length) — the header was not part of the key — so the
//      second `session_create` returned the first session's data, mis-attributed
//      to the wrong directory.  Observed 2026-05-18 during the same
//      investigation as #27.
//
// The new key is `${method}:${path}:dir=${directory}:body=${sha256(body)}`,
// where:
//   - `directory` is the wrapper-injected directory (from
//     `normalizedDirectory`, not the raw header — at the time we build the
//     key the header has not been set yet in `customFetch`);
//   - `body` is the hex digest of SHA-256 over the serialized body bytes,
//     truncated to 16 hex chars (8 bytes, ~10^-19 collision rate over our
//     dedup window — overkill but cheap).
//
// Consequences:
//   - GET/HEAD/OPTIONS/DELETE bypass dedup entirely (unchanged behaviour).
//   - POST/PUT/PATCH dedup correctly on body and directory.
//   - One SHA-256 per POST in customFetch; negligible vs network cost.
//
// The body is read via `await req.text()` early in `customFetch`, which
// consumes `req.body`.  The wrapped `fetchReq` we send downstream is
// constructed with the same text as a string body — fetch handles strings
// natively without the `duplex: "half"` dance that the streaming-body
// version required.

async function idempotencyFingerprint(
  method: string,
  path: string,
  directory: string,
  bodyText: string
): Promise<string> {
  let bodyHash = "empty";
  if (bodyText.length > 0) {
    const data = new TextEncoder().encode(bodyText);
    const digest = await crypto.subtle.digest("SHA-256", data);
    bodyHash = Array.from(new Uint8Array(digest))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("")
      .slice(0, 16);
  }
  return `${method}:${path}:dir=${directory}:body=${bodyHash}`;
}

// ── Factory ────────────────────────────────────────────────────────────

/**
 * Create an OpenCode client backed by the official `@opencode-ai/sdk`,
 * augmented with Cowork-specific extensions (directory injection,
 * idempotency, retry policy, lazy reconnection, structured errors).
 *
 * The returned client exposes the full SDK surface (session, event, etc.)
 * with type-safety from the auto-generated OpenAPI types.
 *
 * @param opts - Connection options matching `OpenCodeClientOptions`.
 * @returns A configured `OpencodeClient` from the SDK.
 */
export function createCoworkClient(opts: CoworkClientOptions): OpencodeClient {
  const baseUrl = opts.baseUrl.replace(/\/$/, "");

  // Build auth header once (same logic as OpenCodeClient constructor)
  const password = opts.password;
  const authHeader =
    password
      ? "Basic " +
        Buffer.from(`${opts.username ?? "opencode"}:${password}`).toString("base64")
      : undefined;

  // Validate directory once at construction time so callers get a
  // fast-fail on bad paths (same behaviour as OpenCodeClient.headers()).
  const normalizedDirectory = normalizeDirectory(opts.directory);

  // Reconnect bookkeeping (lazy, per-factory instance)
  let reconnectAttempts = 0;

  const customFetch: typeof globalThis.fetch = async (input, init) => {
    // The SDK always passes a Request object.  Use it directly — wrapping
    // with `new Request(input, init)` can cause "Body already read" errors
    // in node:undici when the SDK's internal client reuses body streams.
    const req = input instanceof Request ? input : new Request(input, init);

    const method = req.method.toUpperCase();
    const url = req.url;
    const urlObj = new URL(url);
    const path = urlObj.pathname;

    // ── Pre-read body for body-aware dedup (issue #27 fix) ──
    //
    // Read the body once, early, so we can:
    //   a) hash it for an accurate dedup key (see idempotencyFingerprint());
    //   b) reuse the same text when building the downstream Request.
    //
    // GET/HEAD never carry a body, so we skip this work.  For any other
    // method, we tolerate `req.body === null` (which happens when the SDK
    // sends an explicit empty-body POST) by treating it as an empty string.
    const carriesBody = method !== "GET" && method !== "HEAD";
    const bodyText: string =
      carriesBody && req.body ? await req.text() : "";

    // ── 1. Idempotency dedup check (MEK-284, fixed in issue #27) ──
    //
    // Fingerprint is body-aware AND directory-aware: two POSTs to the same
    // path with different commands / titles / directories produce distinct
    // keys and DO NOT collide in the cache.  See idempotencyFingerprint()
    // for the full rationale and the bug-class history.
    let dedupKey: string | undefined;
    if (IDEMPOTENCY_WINDOW_MS > 0 && IDEMPOTENT_METHODS.has(method)) {
      dedupKey = await idempotencyFingerprint(
        method,
        path,
        normalizedDirectory ?? "",
        bodyText
      );

      // Lazy GC: drop expired entries
      const now = Date.now();
      for (const [k, entry] of idempotencyMap) {
        if (entry.expiresAt <= now) idempotencyMap.delete(k);
      }

      const existing = idempotencyMap.get(dedupKey);
      // CRITICAL: clone the Response before returning to the deduped caller.
      // The cached promise resolves to a single Response whose body stream
      // can be read exactly once.  Without .clone(), the SECOND caller's
      // body-read fails with "Body is unusable: Body has already been read"
      // (the symptom that initially looked like an undici/SDK bug).
      // See MEK-296 investigation post-mortem.
      if (existing) return existing.promise.then((r) => r.clone());
    }

    // ── 2. Build modified request with Cowork headers + the body text ──
    //
    // Body is passed as a string (not the original ReadableStream, which
    // has been consumed by the early `await req.text()` above).  String
    // bodies don't require the `duplex: "half"` half-duplex hint.
    const headers = new Headers(req.headers);
    if (normalizedDirectory) {
      headers.set("x-opencode-directory", normalizedDirectory);
    }
    if (authHeader) {
      headers.set("Authorization", authHeader);
    }

    const fetchReq = new Request(url, {
      method: req.method,
      headers,
      body: carriesBody ? bodyText : undefined,
    });

    // ── 3. Core fetch logic (retry loop + error handling) ──
    //
    // Wrapped in an async IIFE so we can store the in-flight Promise
    // in the idempotency map BEFORE the first `await fetch()` yields
    // control to another concurrent caller.

    const doFetch = async (): Promise<Response> => {
      let lastError: Error | undefined;

      for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
        if (attempt > 0) {
          const delay = BASE_DELAY_MS * Math.pow(2, attempt - 1);
          await new Promise((r) => setTimeout(r, delay));
        }

        try {
          const res = await globalThis.fetch(fetchReq);

          if (!res.ok) {
            const text = await res.text();
            const err = new OpenCodeError(
              `${method} ${path} failed (${res.status}): ${text}`,
              res.status,
              method,
              path,
              text
            );
            if (err.isTransient && attempt < MAX_RETRIES && isSafeToRetry(method, path)) {
              lastError = err;
              continue;
            }
            throw err;
          }

          return res;
        } catch (e) {
          if (e instanceof OpenCodeError) throw e;
          lastError = e as Error;
          if (!isSafeToRetry(method, path) || attempt >= MAX_RETRIES) break;
        }
      }

      // ── 4. Lazy reconnection (MEK-280) ──
      if (
        opts.autoServe &&
        reconnectAttempts < MAX_RECONNECT_ATTEMPTS &&
        lastError &&
        isConnectionError(lastError)
      ) {
        reconnectAttempts++;
        console.error(
          `[CoworkClient] Connection failed (attempt ${reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS}), attempting server reconnection...`
        );
        try {
          const status = await isServerRunning(baseUrl, opts.username, password);
          if (!status.healthy) {
            await ensureServer({
              baseUrl,
              autoServe: true,
              username: opts.username,
              password,
            });
          }
          if (dedupKey) {
            idempotencyMap.delete(dedupKey);
          }
          return await globalThis.fetch(fetchReq);
        } catch (reconnectErr) {
          console.error(
            `[CoworkClient] Server reconnection failed: ${
              reconnectErr instanceof Error ? reconnectErr.message : String(reconnectErr)
            }`
          );
        }
      }

      throw lastError ?? new Error(`${method} ${path} failed after retries`);
    };

    // Store in-flight promise for idempotency dedup BEFORE the first await.
    // The FIRST caller also gets a clone — keeps the original Response in
    // the cache pristine so subsequent dedupped callers can each clone it.
    // See dedup hit branch above for the "Body already read" rationale.
    if (dedupKey) {
      const promise = doFetch();
      idempotencyMap.set(dedupKey, {
        promise,
        expiresAt: Date.now() + IDEMPOTENCY_WINDOW_MS,
      });
      return promise.then((r) => r.clone());
    }

    return doFetch();
  };

  // Construct the SDK client.
  //
  // SDK gap: createOpencodeClient({ directory }) only does encodeURIComponent
  // on the directory — it does NOT validate existence or translate Windows/WSL
  // paths (MEK-289). We inject the validated+translated directory in
  // customFetch above. See SPEC-fork.md.
  const client = createOpencodeClient({
    baseUrl,
    fetch: customFetch,
  });

  return client;
}
