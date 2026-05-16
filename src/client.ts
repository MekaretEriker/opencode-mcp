/**
 * HTTP client wrapper for the OpenCode server API.
 *
 * Features:
 *  - Basic auth support
 *  - Automatic retry with exponential backoff for transient errors
 *  - Method/path-aware retry (MEK-281): POST/PUT/PATCH never retried
 *  - Idempotency keys (MEK-284): in-flight POST/PUT/PATCH dedup via Map
 *  - Proper 204 No Content handling on all methods
 *  - SSE streaming support
 *  - Error categorization (transient vs permanent)
 *  - Directory path normalization and validation
 *  - Lazy server reconnection on connection failure
 */

import { createHash } from "node:crypto";
import { normalizeDirectory } from "./helpers.js";
import { ensureServer, isServerRunning } from "./server-manager.js";

export interface OpenCodeClientOptions {
  baseUrl: string;
  username?: string;
  password?: string;
  /** Enable lazy server reconnection when connection fails. */
  autoServe?: boolean;
}

export class OpenCodeError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly method: string,
    public readonly path: string,
    public readonly body: string,
  ) {
    super(message);
    this.name = "OpenCodeError";
  }

  get isTransient(): boolean {
    return (
      this.status === 429 ||
      this.status === 502 ||
      this.status === 503 ||
      this.status === 504
    );
  }

  get isNotFound(): boolean {
    return this.status === 404;
  }

  get isAuth(): boolean {
    return this.status === 401 || this.status === 403;
  }
}

const MAX_RETRIES = 2;
const BASE_DELAY_MS = 500;

/** Max reconnection attempts per MCP session lifetime. */
const MAX_RECONNECT_ATTEMPTS = 3;

/**
 * HTTP methods that are idempotent and safe to retry. Non-idempotent methods
 * (POST, PUT, PATCH) are excluded because if the server already received and
 * processed the request but couldn't return a response in time, retrying
 * creates duplicate state — e.g. duplicate user messages in an OpenCode
 * session queue. See MEK-281.
 */
const SAFE_TO_RETRY_METHODS = new Set(["GET", "HEAD", "OPTIONS", "DELETE"]);

/**
 * Paths that should NEVER be retried regardless of method, because they
 * trigger queue-pollution server-side. POST to these paths is the canonical
 * case of MEK-281 (4 duplicate prompts after a client timeout). DELETE on the
 * same paths is included defensively, although it's idempotent at the entity
 * level it can race with concurrent writes from another caller.
 */
const UNSAFE_RETRY_PATHS: RegExp[] = [
  /\/session\/[^/]+\/message$/,
  /\/session\/[^/]+\/prompt_async$/,
];

/**
 * Decide whether a (method, path) combination is safe to retry after a
 * network/abort error or a transient HTTP error (429/502/503/504).
 * Defaults to false (= don't retry) when in doubt.
 */
function isSafeToRetry(method: string, path: string): boolean {
  const upper = method.toUpperCase();
  if (!SAFE_TO_RETRY_METHODS.has(upper)) {
    return false;
  }
  if (UNSAFE_RETRY_PATHS.some((re) => re.test(path))) {
    return false;
  }
  return true;
}

// ─── MEK-284: Idempotency layer ───────────────────────────────────────
//
// Dedup transparent des POST/PUT/PATCH identiques en flight ou récemment
// résolus. Empêche les doublons côté serveur quand un caller (le wrapper
// lui-même, le client MCP, l'utilisateur, un MCP client buggué) re-soumet
// la même requête dans la fenêtre TTL.
//
// Complément à MEK-281 :
//  - MEK-281 fast-fails les retries sur POST/PUT/PATCH côté wrapper
//  - MEK-284 dédup silencieusement quoi qu'il arrive en amont
//
// Configurable via env `OPENCODE_MCP_IDEMPOTENCY_WINDOW_MS` (= 0 disables).

type IdempotencyEntry = {
  promise: Promise<unknown>;
  expiresAt: number;
};

/** Map en mémoire des promises en flight + récemment résolues. */
const idempotencyMap = new Map<string, IdempotencyEntry>();

/** Fenêtre TTL pour le cache de dedup. Default 60s, override via env. */
const IDEMPOTENCY_WINDOW_MS = (() => {
  const raw = process.env.OPENCODE_MCP_IDEMPOTENCY_WINDOW_MS;
  if (raw === undefined) return 60_000;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : 60_000;
})();

/** Méthodes HTTP soumises au dedup idempotency. */
const IDEMPOTENT_METHODS = new Set(["POST", "PUT", "PATCH"]);

/** sha256 helper sur node:crypto. */
function sha256(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

/**
 * Build a stable idempotency key for a (method, path, body) triple.
 * Body is JSON-stringified so different model/agent/variant params produce
 * distinct keys even with the same prompt text.
 */
function buildIdempotencyKey(method: string, path: string, body: unknown): string {
  const bodyHash = body !== undefined ? sha256(JSON.stringify(body)) : "";
  return `${method}:${path}:${bodyHash}`;
}

/**
 * Test-only helper: reset the in-memory map. Used by vitest to isolate tests.
 * Not part of the public API.
 *
 * @internal
 */
export function _resetIdempotencyMap(): void {
  idempotencyMap.clear();
}

/** Check if an error looks like a connection failure (server unreachable). */
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

export class OpenCodeClient {
  private baseUrl: string;
  private authHeader?: string;
  private autoServe: boolean;
  private reconnectAttempts = 0;
  private username?: string;
  private password?: string;

  constructor(options: OpenCodeClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/$/, "");
    this.autoServe = options.autoServe ?? false;
    this.username = options.username;
    this.password = options.password;
    if (options.password) {
      const username = options.username ?? "opencode";
      this.authHeader =
        "Basic " +
        Buffer.from(`${username}:${options.password}`).toString("base64");
    }
  }

  getBaseUrl(): string {
    return this.baseUrl;
  }

  private buildUrl(path: string, query?: Record<string, string>): string {
    const url = new URL(path, this.baseUrl);
    if (query) {
      for (const [key, value] of Object.entries(query)) {
        if (value !== undefined && value !== "") {
          url.searchParams.set(key, value);
        }
      }
    }
    return url.toString();
  }

  private headers(accept?: string, directory?: string): Record<string, string> {
    const h: Record<string, string> = {
      "Content-Type": "application/json",
      Accept: accept ?? "application/json",
    };
    if (this.authHeader) {
      h["Authorization"] = this.authHeader;
    }
    // Normalize and validate the directory path before sending as header
    const normalized = normalizeDirectory(directory);
    if (normalized) {
      h["x-opencode-directory"] = normalized;
    }
    return h;
  }

  /**
   * Public entry point — wraps doRequest with MEK-284 idempotency dedup
   * for POST/PUT/PATCH. GET/HEAD/OPTIONS/DELETE skip the cache entirely.
   */
  private async request<T = unknown>(
    method: string,
    path: string,
    opts?: {
      query?: Record<string, string>;
      body?: unknown;
      timeout?: number;
      directory?: string;
    },
  ): Promise<T> {
    // MEK-284: dedup non-idempotent in-flight or recently-resolved requests.
    if (IDEMPOTENCY_WINDOW_MS > 0 && IDEMPOTENT_METHODS.has(method.toUpperCase())) {
      const key = buildIdempotencyKey(method, path, opts?.body);

      // Lazy GC: drop expired entries on each insert attempt.
      const now = Date.now();
      for (const [k, entry] of idempotencyMap) {
        if (entry.expiresAt <= now) idempotencyMap.delete(k);
      }

      const existing = idempotencyMap.get(key);
      if (existing) {
        return existing.promise as Promise<T>;
      }

      const promise = this.doRequest<T>(method, path, opts);
      idempotencyMap.set(key, { promise, expiresAt: now + IDEMPOTENCY_WINDOW_MS });
      return promise;
    }

    return this.doRequest<T>(method, path, opts);
  }

  /** Actual HTTP request impl (formerly the body of request()). */
  private async doRequest<T = unknown>(
    method: string,
    path: string,
    opts?: {
      query?: Record<string, string>;
      body?: unknown;
      timeout?: number;
      directory?: string;
    },
  ): Promise<T> {
    const url = this.buildUrl(path, opts?.query);
    let lastError: Error | undefined;

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      if (attempt > 0) {
        const delay = BASE_DELAY_MS * Math.pow(2, attempt - 1);
        await new Promise((r) => setTimeout(r, delay));
      }

      try {
        const controller = new AbortController();
        const timeoutId = opts?.timeout
          ? setTimeout(() => controller.abort(), opts.timeout)
          : undefined;

        const res = await fetch(url, {
          method,
          headers: this.headers(undefined, opts?.directory),
          body:
            opts?.body !== undefined ? JSON.stringify(opts.body) : undefined,
          signal: controller.signal,
        });

        if (timeoutId) clearTimeout(timeoutId);

        if (!res.ok) {
          const text = await res.text();
          const err = new OpenCodeError(
            `${method} ${path} failed (${res.status}): ${text}`,
            res.status,
            method,
            path,
            text,
          );
          if (err.isTransient && attempt < MAX_RETRIES && isSafeToRetry(method, path)) {
            lastError = err;
            continue;
          }
          throw err;
        }

        // Handle 204 No Content
        if (res.status === 204) {
          return undefined as T;
        }

        const contentType = res.headers.get("content-type") ?? "";
        if (contentType.includes("application/json")) {
          return (await res.json()) as T;
        }
        // Return text for non-JSON responses
        return (await res.text()) as unknown as T;
      } catch (e) {
        if (e instanceof OpenCodeError) throw e;
        lastError = e as Error;
        // MEK-281: don't retry POST/PUT/PATCH on network errors — the server
        // may have already received and processed the request, so retrying
        // creates duplicate state. Same for /session/.../message even on
        // safe methods.
        if (!isSafeToRetry(method, path) || attempt >= MAX_RETRIES) break;
      }
    }

    // Lazy reconnection: if all retries exhausted and error looks like a
    // connection failure, try restarting the server and retry once.
    if (
      this.autoServe &&
      this.reconnectAttempts < MAX_RECONNECT_ATTEMPTS &&
      lastError &&
      isConnectionError(lastError)
    ) {
      this.reconnectAttempts++;
      console.error(
        `Connection failed (attempt ${this.reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS}), attempting server reconnection...`,
      );
      try {
        const status = await isServerRunning(this.baseUrl, this.username, this.password);
        if (!status.healthy) {
          await ensureServer({ 
            baseUrl: this.baseUrl, 
            autoServe: true,
            username: this.username,
            password: this.password
          });
        }
        // Retry the original request once after reconnection.
        // MEK-284: bypass the idempotency cache (which still holds the
        // failed Promise from the first attempt) and invalidate that entry
        // so future identical requests get a fresh attempt instead of the
        // cached failure.
        if (IDEMPOTENT_METHODS.has(method.toUpperCase())) {
          idempotencyMap.delete(buildIdempotencyKey(method, path, opts?.body));
        }
        return this.doRequest<T>(method, path, opts);
      } catch (reconnectErr) {
        console.error(
          `Server reconnection failed: ${reconnectErr instanceof Error ? reconnectErr.message : String(reconnectErr)}`,
        );
      }
    }

    throw lastError ?? new Error(`${method} ${path} failed after retries`);
  }

  async get<T = unknown>(
    path: string,
    query?: Record<string, string>,
    directory?: string,
  ): Promise<T> {
    return this.request<T>("GET", path, { query, directory });
  }

  async post<T = unknown>(
    path: string,
    body?: unknown,
    opts?: { timeout?: number; directory?: string },
  ): Promise<T> {
    return this.request<T>("POST", path, {
      body,
      timeout: opts?.timeout,
      directory: opts?.directory,
    });
  }

  async patch<T = unknown>(
    path: string,
    body?: unknown,
    directory?: string,
  ): Promise<T> {
    return this.request<T>("PATCH", path, { body, directory });
  }

  async put<T = unknown>(
    path: string,
    body?: unknown,
    directory?: string,
  ): Promise<T> {
    return this.request<T>("PUT", path, { body, directory });
  }

  async delete<T = unknown>(
    path: string,
    query?: Record<string, string>,
    directory?: string,
  ): Promise<T> {
    return this.request<T>("DELETE", path, { query, directory });
  }

  /**
   * Subscribe to SSE events. Returns an async iterable of parsed events.
   * The caller should break out of the loop when done.
   */
  async *subscribeSSE(
    path: string,
    opts?: { signal?: AbortSignal },
  ): AsyncGenerator<{ event: string; data: string }, void, undefined> {
    const url = this.buildUrl(path);
    const res = await fetch(url, {
      method: "GET",
      headers: {
        ...this.headers("text/event-stream"),
        Accept: "text/event-stream",
        "Cache-Control": "no-cache",
      },
      signal: opts?.signal,
    });

    if (!res.ok) {
      const text = await res.text();
      throw new OpenCodeError(
        `SSE ${path} failed (${res.status}): ${text}`,
        res.status,
        "GET",
        path,
        text,
      );
    }

    if (!res.body) {
      throw new Error("No response body for SSE stream");
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let currentEvent = "";
    let currentData = "";

    const abortHandler = () => {
      try {
        // Cancels any pending reader.read() and causes the generator to unwind.
        void reader.cancel().catch(() => {
          // ignore
        });
      } catch {
        // ignore
      }
    };

    if (opts?.signal) {
      if (opts.signal.aborted) abortHandler();
      else opts.signal.addEventListener("abort", abortHandler, { once: true });
    }

    try {
      while (true) {
        if (opts?.signal?.aborted) break;
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";

        for (const line of lines) {
          if (line.startsWith("event:")) {
            currentEvent = line.slice(6).trim();
          } else if (line.startsWith("data:")) {
            currentData = line.slice(5).trim();
          } else if (line === "") {
            if (currentData) {
              yield { event: currentEvent || "message", data: currentData };
              currentEvent = "";
              currentData = "";
            }
          }
        }
      }
    } finally {
      if (opts?.signal) {
        try {
          opts.signal.removeEventListener("abort", abortHandler);
        } catch {
          // ignore
        }
      }
      reader.releaseLock();
    }
  }
}
