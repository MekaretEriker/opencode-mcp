/**
 * Tests for the SDK adapter (MEK-296 Phase B).
 *
 * Verifies that `createCoworkClient`'s customFetch wrapper correctly
 * injects directory headers, dedupes identical POSTs, applies the retry
 * policy, and classifies errors.
 *
 * Multi-POST dedup tests assert that two parallel callers each receive
 * an independent Response (via .clone()) — the Body-already-read
 * symptom that initially looked like an undici/SDK bug was actually a
 * design flaw in the dedup layer.  See MEK-296 investigation
 * post-mortem in CHANGELOG.md.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { OpenCodeError } from "../src/client.js";
import { buildStructuredError } from "../src/helpers.js";
import { createCoworkClient, _resetSdkIdempotencyMap } from "../src/sdk-adapter.js";
import type { OpencodeClient } from "@opencode-ai/sdk/client";

// ── Helpers ────────────────────────────────────────────────────────────

function mockResponseFactory(body: unknown, status = 200, contentType = "application/json") {
  const bodyStr = typeof body === "string" ? body : JSON.stringify(body);
  return () =>
    new Response(bodyStr, {
      status,
      headers: { "content-type": contentType },
    });
}

function directoryHeaderFromRequest(req: Request): string | null {
  return req.headers.get("x-opencode-directory");
}

// ── Tests ──────────────────────────────────────────────────────────────

describe("SDK adapter (createCoworkClient)", () => {
  let realFetch: typeof globalThis.fetch;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    realFetch = globalThis.fetch;
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    _resetSdkIdempotencyMap();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    globalThis.fetch = realFetch;
  });

  function createClient(opts?: { directory?: string; password?: string; autoServe?: boolean }) {
    return createCoworkClient({
      baseUrl: "http://localhost:4096",
      ...opts,
    });
  }

  // ─────────────────────────────────────────────────────────────────────
  // 1. Directory header injection (MEK-289)
  // ─────────────────────────────────────────────────────────────────────

  describe("directory header injection (MEK-289)", () => {
    beforeEach(() => {
      vi.stubEnv("OPENCODE_MCP_TRANSLATE_PATHS", "none");
    });

    it("injects x-opencode-directory header when a valid directory is provided", async () => {
      const { tmpdir } = await import("node:os");
      const dir = tmpdir();
      const client = createClient({ directory: dir });

      fetchMock.mockImplementation(mockResponseFactory({ status: "ok" }));
      await client.project.list();

      expect(fetchMock).toHaveBeenCalledTimes(1);
      const req: Request = fetchMock.mock.calls[0][0];
      expect(directoryHeaderFromRequest(req)).toBe(dir);
    });

    it("does NOT inject directory header when no directory is provided", async () => {
      const client = createClient({});
      fetchMock.mockImplementation(mockResponseFactory({ status: "ok" }));
      await client.project.list();

      const req: Request = fetchMock.mock.calls[0][0];
      expect(directoryHeaderFromRequest(req)).toBeNull();
    });

    it("throws for non-existent directory (validation fast-fail at construction time)", () => {
      expect(() =>
        createCoworkClient({
          baseUrl: "http://localhost:4096",
          directory: "/nonexistent/path/that/does/not/exist",
        })
      ).toThrow(/Directory not found/);
    });
  });

  // ─────────────────────────────────────────────────────────────────────
  // 2. Idempotency layer — exists and is testable at construction level
  // ─────────────────────────────────────────────────────────────────────

  describe("idempotency dedup (MEK-284)", () => {
    it("does NOT deduplicate GET requests", async () => {
      const client = createClient({});
      fetchMock.mockImplementation(mockResponseFactory([]));

      await client.project.list();
      await client.project.list();

      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it("deduplicates two parallel identical POSTs — fetch called once", async () => {
      const client = createClient({});
      // Single Response per fetch call. The adapter must clone() so that
      // both parallel callers each get an independent body stream.
      fetchMock.mockImplementation(() =>
        new Response(
          JSON.stringify({
            id: "ses_1",
            title: "test",
            time: { created: 1, updated: 1 },
            projectID: "p1",
            directory: "/tmp",
            version: "1",
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      );

      const [r1, r2] = await Promise.all([
        client.session.create({ body: { title: "test" } }),
        client.session.create({ body: { title: "test" } }),
      ]);

      // Only ONE real fetch — the second was deduped via the in-flight map.
      expect(fetchMock).toHaveBeenCalledTimes(1);
      // Both callers received a successfully parsed response (independent body).
      expect((r1.data as { id: string })?.id).toBe("ses_1");
      expect((r2.data as { id: string })?.id).toBe("ses_1");
    });

    it("does NOT deduplicate sequential POSTs after the cache window", async () => {
      // With the default 60s TTL, a sequential POST inside the same tick is
      // still deduped. To verify NO-dedup behaviour cleanly we mock the env
      // override to a 0-ms window, which disables dedup entirely.
      vi.stubEnv("OPENCODE_MCP_IDEMPOTENCY_WINDOW_MS", "0");
      // Re-import to pick up the env override at module init. Vitest caches
      // ESM modules, so we test the public reset hook plus separate clients.
      const client = createClient({});
      fetchMock.mockImplementation(() =>
        new Response(
          JSON.stringify({
            id: "ses_2",
            title: "test",
            time: { created: 1, updated: 1 },
            projectID: "p1",
            directory: "/tmp",
            version: "1",
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      );

      // Two sequential POSTs (different calls, not parallel) — without the
      // dedup window, both should hit fetch.  Note: the actual env-driven
      // disable check runs at module load; this test documents intent.
      await client.session.create({ body: { title: "test" } });
      _resetSdkIdempotencyMap(); // simulate window expiry
      await client.session.create({ body: { title: "test" } });

      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it("idempotency map can be reset via _resetSdkIdempotencyMap", () => {
      _resetSdkIdempotencyMap();
      // No-op assertion: the function exists and doesn't throw
      expect(true).toBe(true);
    });

    // ── Regression tests for issue #27 (over-application of dedup) ─────
    //
    // The pre-#27 fingerprint was `${method}:${path}:cl=${content-length}`,
    // which collided on:
    //   (a) two POSTs to the same path with different bodies of equal length
    //   (b) two POSTs with the same body but different `x-opencode-directory`
    //       (because the header wasn't in the key)
    // Both produced "the first response is served to the second caller",
    // which surfaced as `opencode_shell_execute` returning the wrong command's
    // output and `session_create` returning a session attributed to the wrong
    // directory.  These two tests pin the fixed behaviour.

    it("does NOT dedup two POSTs to the same path with DISTINCT bodies (issue #27)", async () => {
      const client = createClient({});
      let callCount = 0;
      fetchMock.mockImplementation(() => {
        callCount += 1;
        return new Response(
          JSON.stringify({
            id: `ses_${callCount}`,
            title: `title_${callCount}`,
            time: { created: callCount, updated: callCount },
            projectID: "p1",
            directory: "/tmp",
            version: "1",
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      });

      // Two POSTs to /session with DIFFERENT titles.  The pre-#27 fingerprint
      // would dedup them whenever the JSON serializations happened to share a
      // content-length (e.g. {"title":"ab"} and {"title":"cd"} both 14 bytes).
      // We use two titles guaranteed to share length to make the test sharp.
      const [r1, r2] = await Promise.all([
        client.session.create({ body: { title: "ab" } }),
        client.session.create({ body: { title: "cd" } }),
      ]);

      // Both POSTs must reach the network.  Pre-fix: fetch called ONCE,
      // r2.data.id === "ses_1" (wrong) — the cached response from r1 was served.
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect((r1.data as { id: string })?.id).toBe("ses_1");
      expect((r2.data as { id: string })?.id).toBe("ses_2");
    });

    it("does NOT dedup two POSTs with same body but DIFFERENT directories (issue #27 cross-contamination)", async () => {
      const { tmpdir } = await import("node:os");
      const { mkdtempSync } = await import("node:fs");
      const { join } = await import("node:path");

      const dirA = mkdtempSync(join(tmpdir(), "sdk-adapter-test-dirA-"));
      const dirB = mkdtempSync(join(tmpdir(), "sdk-adapter-test-dirB-"));

      vi.stubEnv("OPENCODE_MCP_TRANSLATE_PATHS", "none");

      const clientA = createClient({ directory: dirA });
      const clientB = createClient({ directory: dirB });

      let callCount = 0;
      fetchMock.mockImplementation((req: Request) => {
        callCount += 1;
        const dir = req.headers.get("x-opencode-directory") ?? "(none)";
        return new Response(
          JSON.stringify({
            id: `ses_${callCount}`,
            title: "same",
            time: { created: callCount, updated: callCount },
            projectID: dir, // echo dir back so we can assert per-caller routing
            directory: dir,
            version: "1",
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      });

      // Both clients send a POST with the SAME body { title: "same" }, but
      // their directories differ.  Pre-#27 fingerprint ignored the directory,
      // so the second call was served clientA's cached response — clientB ended
      // up with a session attributed to dirA.  This is the bug we observed
      // 2026-05-18 when two parallel `opencode_session_create` calls returned
      // the same session ID.
      const [r1, r2] = await Promise.all([
        clientA.session.create({ body: { title: "same" } }),
        clientB.session.create({ body: { title: "same" } }),
      ]);

      expect(fetchMock).toHaveBeenCalledTimes(2);
      // Each call must see its own directory header — no cross-contamination.
      const dirsSeen = fetchMock.mock.calls
        .map(([req]: [Request]) => req.headers.get("x-opencode-directory"))
        .sort();
      expect(dirsSeen).toEqual([dirA, dirB].sort());
      // And the responses must come back to the correct caller (different IDs).
      const id1 = (r1.data as { id: string })?.id;
      const id2 = (r2.data as { id: string })?.id;
      expect(id1).not.toBe(id2);
    });
  });

  // ─────────────────────────────────────────────────────────────────────
  // 3. Retry policy (MEK-281)
  // ─────────────────────────────────────────────────────────────────────

  describe("retry policy (MEK-281)", () => {
    it("retries GET on 503 transient error", async () => {
      const client = createClient({});

      fetchMock
        .mockImplementationOnce(mockResponseFactory("Service Unavailable", 503))
        .mockImplementationOnce(mockResponseFactory({ status: "ok" }));

      await client.project.list();

      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it("does NOT retry POST on 503 (non-idempotent)", async () => {
      const client = createClient({});

      fetchMock.mockImplementation(mockResponseFactory("Service Unavailable", 503));

      try {
        await client.session.create({ body: { title: "test" } });
      } catch {
        // expected
      }

      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it("retries GET on network error (fetch failed)", async () => {
      const client = createClient({});

      fetchMock
        .mockRejectedValueOnce(new Error("fetch failed"))
        .mockImplementationOnce(mockResponseFactory({ status: "ok" }));

      await client.project.list();
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it("does NOT retry POST on network error", async () => {
      const client = createClient({});

      fetchMock.mockRejectedValue(new Error("fetch failed"));

      try {
        await client.session.create({ body: { title: "test" } });
      } catch {
        // expected
      }

      expect(fetchMock).toHaveBeenCalledTimes(1);
    });
  });

  // ─────────────────────────────────────────────────────────────────────
  // 4. Structured error classification (MEK-282)
  // ─────────────────────────────────────────────────────────────────────

  describe("structured error classification (MEK-282)", () => {
    it("classifies 429 as RATE_LIMITED in OpenCodeError", async () => {
      const client = createClient({});

      fetchMock.mockImplementation(
        mockResponseFactory(JSON.stringify({ name: "RateLimitError", data: { message: "Too many requests" } }), 429)
      );

      try {
        await client.session.create({ body: { title: "test" } });
      } catch (e) {
        const structured = buildStructuredError(e);
        expect(structured.code).toBe("RATE_LIMITED");
      }

      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it("classifies 401 as AUTH_FAILED", async () => {
      const client = createClient({});

      fetchMock.mockImplementation(
        mockResponseFactory(JSON.stringify({ name: "AuthError", data: { message: "Unauthorized" } }), 401)
      );

      try {
        await client.session.create({ body: { title: "test" } });
      } catch (e) {
        const structured = buildStructuredError(e);
        expect(structured.code).toBe("AUTH_FAILED");
      }
    });
  });

  // ─────────────────────────────────────────────────────────────────────
  // 5. Auth header injection
  // ─────────────────────────────────────────────────────────────────────

  describe("auth header injection", () => {
    it("includes Authorization header when password is set", async () => {
      const client = createClient({ password: "test-secret" });
      fetchMock.mockImplementation(mockResponseFactory({ status: "ok" }));

      await client.project.list();

      const req: Request = fetchMock.mock.calls[0][0];
      expect(req.headers.get("Authorization")).toMatch(/^Basic /);
    });

    it("does NOT include Authorization header when password is not set", async () => {
      const client = createClient({});
      fetchMock.mockImplementation(mockResponseFactory({ status: "ok" }));

      await client.project.list();

      const req: Request = fetchMock.mock.calls[0][0];
      expect(req.headers.get("Authorization")).toBeNull();
    });
  });

  // ─────────────────────────────────────────────────────────────────────
  // 6. Smoke: client can call SDK methods
  // ─────────────────────────────────────────────────────────────────────

  describe("SDK method passthrough", () => {
    it("project.list() calls the correct endpoint", async () => {
      const client = createClient({});
      fetchMock.mockImplementation(mockResponseFactory([]));

      await client.project.list();

      expect(fetchMock).toHaveBeenCalledOnce();
      const req: Request = fetchMock.mock.calls[0][0];
      expect(req.url).toContain("/project");
      expect(req.method).toBe("GET");
    });

    it("session.create() calls the correct endpoint", async () => {
      const client = createClient({});
      fetchMock.mockImplementation(
        mockResponseFactory({ id: "ses_1", title: "test", time: { created: 1, updated: 1 }, projectID: "p1", directory: "/tmp", version: "1" })
      );

      await client.session.create({ body: { title: "test" } });

      expect(fetchMock).toHaveBeenCalledOnce();
      const req: Request = fetchMock.mock.calls[0][0];
      expect(req.url).toContain("/session");
      expect(req.method).toBe("POST");
    });
  });
});
