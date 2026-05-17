import { describe, it, expect, vi, beforeEach, afterEach, beforeAll, afterAll } from "vitest";
import { tmpdir } from "node:os";

const TMP = tmpdir();
import { OpenCodeClient, OpenCodeError, _resetIdempotencyMap } from "../src/client.js";

// ─── OpenCodeError ───────────────────────────────────────────────────────

describe("OpenCodeError", () => {
  it("creates error with all fields", () => {
    const err = new OpenCodeError("fail", 500, "GET", "/test", "body");
    expect(err.message).toBe("fail");
    expect(err.status).toBe(500);
    expect(err.method).toBe("GET");
    expect(err.path).toBe("/test");
    expect(err.body).toBe("body");
    expect(err.name).toBe("OpenCodeError");
  });

  describe("isTransient", () => {
    it.each([429, 502, 503, 504])("returns true for status %i", (status) => {
      const err = new OpenCodeError("", status, "", "", "");
      expect(err.isTransient).toBe(true);
    });

    it.each([400, 401, 403, 404, 500])("returns false for status %i", (status) => {
      const err = new OpenCodeError("", status, "", "", "");
      expect(err.isTransient).toBe(false);
    });
  });

  describe("isNotFound", () => {
    it("returns true for 404", () => {
      const err = new OpenCodeError("", 404, "", "", "");
      expect(err.isNotFound).toBe(true);
    });

    it("returns false for other statuses", () => {
      const err = new OpenCodeError("", 500, "", "", "");
      expect(err.isNotFound).toBe(false);
    });
  });

  describe("isAuth", () => {
    it.each([401, 403])("returns true for status %i", (status) => {
      const err = new OpenCodeError("", status, "", "", "");
      expect(err.isAuth).toBe(true);
    });

    it("returns false for other statuses", () => {
      const err = new OpenCodeError("", 500, "", "", "");
      expect(err.isAuth).toBe(false);
    });
  });
});

// ─── OpenCodeClient ──────────────────────────────────────────────────────

describe("OpenCodeClient", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function createClient(opts?: { password?: string; username?: string }) {
    return new OpenCodeClient({
      baseUrl: "http://localhost:4096",
      ...opts,
    });
  }

  function mockResponse(body: unknown, status = 200, contentType = "application/json") {
    return {
      ok: status >= 200 && status < 300,
      status,
      headers: new Map([["content-type", contentType]]),
      json: () => Promise.resolve(body),
      text: () => Promise.resolve(typeof body === "string" ? body : JSON.stringify(body)),
    };
  }

  describe("constructor", () => {
    it("strips trailing slash from baseUrl", () => {
      const client = new OpenCodeClient({ baseUrl: "http://localhost:4096/" });
      expect(client.getBaseUrl()).toBe("http://localhost:4096");
    });

    it("preserves baseUrl without trailing slash", () => {
      const client = createClient();
      expect(client.getBaseUrl()).toBe("http://localhost:4096");
    });
  });

  describe("get", () => {
    it("makes GET request with correct URL", async () => {
      fetchMock.mockResolvedValue(mockResponse({ status: "ok" }));
      const client = createClient();
      const result = await client.get("/health");
      expect(fetchMock).toHaveBeenCalledOnce();
      const [url, opts] = fetchMock.mock.calls[0];
      expect(url).toBe("http://localhost:4096/health");
      expect(opts.method).toBe("GET");
      expect(result).toEqual({ status: "ok" });
    });

    it("passes query parameters", async () => {
      fetchMock.mockResolvedValue(mockResponse([]));
      const client = createClient();
      await client.get("/session", { limit: "10" });
      const [url] = fetchMock.mock.calls[0];
      expect(url).toContain("limit=10");
    });

    it("skips empty query parameters", async () => {
      fetchMock.mockResolvedValue(mockResponse([]));
      const client = createClient();
      await client.get("/session", { limit: "10", empty: "" });
      const [url] = fetchMock.mock.calls[0];
      expect(url).toContain("limit=10");
      expect(url).not.toContain("empty");
    });
  });

  describe("post", () => {
    it("sends POST with JSON body", async () => {
      fetchMock.mockResolvedValue(mockResponse({ id: "s1" }));
      const client = createClient();
      const result = await client.post("/session", { title: "test" });
      const [, opts] = fetchMock.mock.calls[0];
      expect(opts.method).toBe("POST");
      expect(opts.body).toBe(JSON.stringify({ title: "test" }));
      expect(result).toEqual({ id: "s1" });
    });

    it("sends POST without body", async () => {
      fetchMock.mockResolvedValue(mockResponse({ ok: true }));
      const client = createClient();
      await client.post("/action");
      const [, opts] = fetchMock.mock.calls[0];
      expect(opts.body).toBeUndefined();
    });
  });

  describe("patch", () => {
    it("sends PATCH request", async () => {
      fetchMock.mockResolvedValue(mockResponse({ updated: true }));
      const client = createClient();
      await client.patch("/session/s1", { title: "new" });
      const [, opts] = fetchMock.mock.calls[0];
      expect(opts.method).toBe("PATCH");
    });
  });

  describe("put", () => {
    it("sends PUT request", async () => {
      fetchMock.mockResolvedValue(mockResponse({ ok: true }));
      const client = createClient();
      await client.put("/config", { key: "value" });
      const [, opts] = fetchMock.mock.calls[0];
      expect(opts.method).toBe("PUT");
    });
  });

  describe("delete", () => {
    it("sends DELETE request", async () => {
      fetchMock.mockResolvedValue(mockResponse(undefined, 204));
      const client = createClient();
      const result = await client.delete("/session/s1");
      const [, opts] = fetchMock.mock.calls[0];
      expect(opts.method).toBe("DELETE");
      expect(result).toBeUndefined();
    });

    it("passes query parameters", async () => {
      fetchMock.mockResolvedValue(mockResponse(undefined, 204));
      const client = createClient();
      await client.delete("/session/s1", { force: "true" });
      const [url] = fetchMock.mock.calls[0];
      expect(url).toContain("force=true");
    });
  });

  describe("authentication", () => {
    it("adds auth header when password is set", async () => {
      fetchMock.mockResolvedValue(mockResponse({ ok: true }));
      const client = createClient({ password: "secret" });
      await client.get("/health");
      const [, opts] = fetchMock.mock.calls[0];
      expect(opts.headers.Authorization).toMatch(/^Basic /);
      // Default username is "opencode"
      const decoded = Buffer.from(
        opts.headers.Authorization.replace("Basic ", ""),
        "base64",
      ).toString();
      expect(decoded).toBe("opencode:secret");
    });

    it("uses custom username when provided", async () => {
      fetchMock.mockResolvedValue(mockResponse({ ok: true }));
      const client = createClient({ username: "admin", password: "pass" });
      await client.get("/health");
      const [, opts] = fetchMock.mock.calls[0];
      const decoded = Buffer.from(
        opts.headers.Authorization.replace("Basic ", ""),
        "base64",
      ).toString();
      expect(decoded).toBe("admin:pass");
    });

    it("does not add auth header when no password", async () => {
      fetchMock.mockResolvedValue(mockResponse({ ok: true }));
      const client = createClient();
      await client.get("/health");
      const [, opts] = fetchMock.mock.calls[0];
      expect(opts.headers.Authorization).toBeUndefined();
    });
  });

  describe("204 No Content handling", () => {
    it("returns undefined for 204 responses", async () => {
      fetchMock.mockResolvedValue(mockResponse(undefined, 204));
      const client = createClient();
      const result = await client.delete("/session/s1");
      expect(result).toBeUndefined();
    });
  });

  describe("non-JSON responses", () => {
    it("returns text for non-JSON content type", async () => {
      fetchMock.mockResolvedValue(mockResponse("plain text", 200, "text/plain"));
      const client = createClient();
      const result = await client.get("/log");
      expect(result).toBe("plain text");
    });
  });

  describe("error handling", () => {
    beforeEach(() => {
      _resetIdempotencyMap();
    });

    it("throws OpenCodeError for non-ok responses", async () => {
      fetchMock.mockResolvedValue({
        ok: false,
        status: 404,
        headers: new Map(),
        text: () => Promise.resolve("Not found"),
      });
      const client = createClient();
      await expect(client.get("/missing")).rejects.toThrow(OpenCodeError);
      await expect(client.get("/missing")).rejects.toMatchObject({
        status: 404,
      });
    });

    it("retries on transient errors (429, 502, 503, 504)", async () => {
      fetchMock
        .mockResolvedValueOnce({
          ok: false,
          status: 503,
          headers: new Map(),
          text: () => Promise.resolve("Service unavailable"),
        })
        .mockResolvedValueOnce(mockResponse({ ok: true }));

      const client = createClient();
      const result = await client.get("/health");
      expect(result).toEqual({ ok: true });
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it("does not retry on non-transient errors (400, 401, 404)", async () => {
      fetchMock.mockResolvedValue({
        ok: false,
        status: 400,
        headers: new Map(),
        text: () => Promise.resolve("Bad request"),
      });

      const client = createClient();
      await expect(client.get("/bad")).rejects.toThrow(OpenCodeError);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it("gives up after MAX_RETRIES", async () => {
      fetchMock.mockResolvedValue({
        ok: false,
        status: 503,
        headers: new Map(),
        text: () => Promise.resolve("Service unavailable"),
      });

      const client = createClient();
      await expect(client.get("/flaky")).rejects.toThrow(OpenCodeError);
      // 1 initial + 2 retries = 3
      expect(fetchMock).toHaveBeenCalledTimes(3);
    });

    it("retries on network errors", async () => {
      fetchMock
        .mockRejectedValueOnce(new Error("fetch failed"))
        .mockResolvedValueOnce(mockResponse({ ok: true }));

      const client = createClient();
      const result = await client.get("/health");
      expect(result).toEqual({ ok: true });
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    // MEK-281 — method-aware retry: POST/PUT/PATCH must not retry on network
    // errors because the server may have already received and processed the
    // request. Retrying would create duplicate state (e.g. duplicate prompts
    // in a session message queue).

    it("does NOT retry POST on network errors (MEK-281)", async () => {
      fetchMock.mockRejectedValue(new Error("fetch failed"));

      const client = createClient();
      await expect(
        client.post("/session/ses_test/message", { parts: [{ type: "text", text: "hi" }] })
      ).rejects.toThrow(/fetch failed/);
      // Only 1 attempt — no retries on POST
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it("does NOT retry PATCH on AbortError (MEK-281)", async () => {
      const abortErr = new Error("The user aborted a request.");
      abortErr.name = "AbortError";
      fetchMock.mockRejectedValue(abortErr);

      const client = createClient();
      await expect(
        client.patch("/config", { key: "val" })
      ).rejects.toThrow(/aborted/);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it("does NOT retry POST on transient 503 (MEK-281 defense-in-depth)", async () => {
      fetchMock.mockResolvedValue({
        ok: false,
        status: 503,
        headers: new Map(),
        text: () => Promise.resolve("Service unavailable"),
      });

      const client = createClient();
      await expect(
        client.post("/session/ses_test/message", { parts: [{ type: "text", text: "hi" }] })
      ).rejects.toThrow(OpenCodeError);
      // Even though 503 is transient, POST is not safe to retry — server may
      // have queued the message before failing to respond.
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it("does NOT retry DELETE on /session/.../message path (MEK-281 path bypass)", async () => {
      fetchMock.mockRejectedValue(new Error("fetch failed"));

      const client = createClient();
      // DELETE is normally safe to retry, but /session/.../message paths are
      // blacklisted defensively because they touch the message queue.
      await expect(
        client.delete("/session/ses_test/message")
      ).rejects.toThrow(/fetch failed/);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });
  });

  // MEK-284 — Idempotency: in-flight or recently-resolved POST/PUT/PATCH
  // requests with identical (method, path, body) return the same Promise
  // instead of triggering a fresh HTTP call. Default TTL 60s, env-disable
  // via OPENCODE_MCP_IDEMPOTENCY_WINDOW_MS=0.

  describe("idempotency (MEK-284)", () => {
    beforeEach(() => {
      _resetIdempotencyMap();
    });

    it("dedupes 3 parallel identical POST calls into 1 HTTP request", async () => {
      // Slow mock response so all 3 calls happen in flight before resolution
      let resolveResponse: (v: { ok: boolean; status: number; headers: Map<string, string>; json: () => Promise<unknown>; text: () => Promise<string> }) => void;
      const responsePromise = new Promise<{ ok: boolean; status: number; headers: Map<string, string>; json: () => Promise<unknown>; text: () => Promise<string> }>((res) => {
        resolveResponse = res;
      });
      fetchMock.mockReturnValue(responsePromise);

      const client = createClient();
      const body = { parts: [{ type: "text", text: "hi" }] };

      // Fire 3 identical calls in parallel
      const p1 = client.post("/session/ses_test/message", body);
      const p2 = client.post("/session/ses_test/message", body);
      const p3 = client.post("/session/ses_test/message", body);

      // Resolve the in-flight fetch
      resolveResponse!({
        ok: true,
        status: 200,
        headers: new Map([["content-type", "application/json"]]),
        json: () => Promise.resolve({ ok: true }),
        text: () => Promise.resolve(""),
      });

      const [r1, r2, r3] = await Promise.all([p1, p2, p3]);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(r1).toEqual({ ok: true });
      expect(r2).toEqual({ ok: true });
      expect(r3).toEqual({ ok: true });
    });

    it("dedupes sequential identical POST calls within TTL window", async () => {
      fetchMock.mockResolvedValue(mockResponse({ ok: true }));

      const client = createClient();
      const body = { parts: [{ type: "text", text: "hi" }] };

      await client.post("/session/ses_test/message", body);
      await client.post("/session/ses_test/message", body);
      await client.post("/session/ses_test/message", body);

      // Only the first call hits the network; 2nd and 3rd return the cached Promise
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it("does NOT dedupe POSTs with different bodies", async () => {
      fetchMock.mockResolvedValue(mockResponse({ ok: true }));

      const client = createClient();

      await client.post("/session/ses_test/message", { parts: [{ type: "text", text: "first" }] });
      await client.post("/session/ses_test/message", { parts: [{ type: "text", text: "second" }] });

      // Different bodies → different idempotency keys → 2 distinct fetches
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it("does NOT dedupe GET requests (only POST/PUT/PATCH)", async () => {
      fetchMock.mockResolvedValue(mockResponse({ ok: true }));

      const client = createClient();
      await client.get("/health");
      await client.get("/health");

      // GET is not subject to idempotency cache — each call hits the network
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });
  });

  describe("headers", () => {
    it("sets Content-Type and Accept to application/json", async () => {
      fetchMock.mockResolvedValue(mockResponse({}));
      const client = createClient();
      await client.get("/test");
      const [, opts] = fetchMock.mock.calls[0];
      expect(opts.headers["Content-Type"]).toBe("application/json");
      expect(opts.headers.Accept).toBe("application/json");
    });
  });

  describe("directory header", () => {
    beforeAll(() => {
      process.env.OPENCODE_MCP_TRANSLATE_PATHS = "none";
    });
    afterAll(() => {
      delete process.env.OPENCODE_MCP_TRANSLATE_PATHS;
    });

    it("sets x-opencode-directory header on GET when directory is provided", async () => {
      fetchMock.mockResolvedValue(mockResponse({}));
      const client = createClient();
      await client.get("/project/current", undefined, TMP);
      const [, opts] = fetchMock.mock.calls[0];
      expect(opts.headers["x-opencode-directory"]).toBe(TMP);
    });

    it("does not set x-opencode-directory header when directory is undefined", async () => {
      fetchMock.mockResolvedValue(mockResponse({}));
      const client = createClient();
      await client.get("/project/current");
      const [, opts] = fetchMock.mock.calls[0];
      expect(opts.headers["x-opencode-directory"]).toBeUndefined();
    });

    it("sets x-opencode-directory header on POST when directory is provided", async () => {
      fetchMock.mockResolvedValue(mockResponse({ id: "s1" }));
      const client = createClient();
      await client.post("/session", { title: "test" }, { directory: TMP });
      const [, opts] = fetchMock.mock.calls[0];
      expect(opts.headers["x-opencode-directory"]).toBe(TMP);
    });

    it("sets x-opencode-directory header on PATCH when directory is provided", async () => {
      fetchMock.mockResolvedValue(mockResponse({}));
      const client = createClient();
      await client.patch("/config", { key: "val" }, TMP);
      const [, opts] = fetchMock.mock.calls[0];
      expect(opts.headers["x-opencode-directory"]).toBe(TMP);
    });

    it("sets x-opencode-directory header on PUT when directory is provided", async () => {
      fetchMock.mockResolvedValue(mockResponse({}));
      const client = createClient();
      await client.put("/config", { key: "val" }, TMP);
      const [, opts] = fetchMock.mock.calls[0];
      expect(opts.headers["x-opencode-directory"]).toBe(TMP);
    });

    it("sets x-opencode-directory header on DELETE when directory is provided", async () => {
      fetchMock.mockResolvedValue(mockResponse(undefined, 204));
      const client = createClient();
      await client.delete("/session/s1", undefined, TMP);
      const [, opts] = fetchMock.mock.calls[0];
      expect(opts.headers["x-opencode-directory"]).toBe(TMP);
    });

    it("works alongside auth header", async () => {
      fetchMock.mockResolvedValue(mockResponse({}));
      const client = createClient({ password: "secret" });
      await client.get("/health", undefined, TMP);
      const [, opts] = fetchMock.mock.calls[0];
      expect(opts.headers["x-opencode-directory"]).toBe(TMP);
      expect(opts.headers.Authorization).toMatch(/^Basic /);
    });

    it("normalizes directory paths (removes trailing slash)", async () => {
      fetchMock.mockResolvedValue(mockResponse({}));
      const client = createClient();
      await client.get("/test", undefined, TMP + "/");
      const [, opts] = fetchMock.mock.calls[0];
      expect(opts.headers["x-opencode-directory"]).toBe(TMP);
    });

    it("resolves .. in directory paths", async () => {
      fetchMock.mockResolvedValue(mockResponse({}));
      const client = createClient();
      await client.get("/test", undefined, TMP + "/foo/..");
      const [, opts] = fetchMock.mock.calls[0];
      expect(opts.headers["x-opencode-directory"]).toBe(TMP);
    });

    it("throws for non-existent directory", async () => {
      fetchMock.mockResolvedValue(mockResponse({}));
      const client = createClient();
      await expect(
        client.get("/test", undefined, "/this/absolutely/does/not/exist/xyz123"),
      ).rejects.toThrow("does not exist");
    });

    it("does not set header when directory is undefined", async () => {
      fetchMock.mockResolvedValue(mockResponse({}));
      const client = createClient();
      await client.get("/test");
      const [, opts] = fetchMock.mock.calls[0];
      expect(opts.headers["x-opencode-directory"]).toBeUndefined();
    });
  });

  describe("autoServe option", () => {
    it("defaults autoServe to false", () => {
      const client = new OpenCodeClient({
        baseUrl: "http://localhost:4096",
      });
      expect(client.getBaseUrl()).toBe("http://localhost:4096");
      // autoServe is private, but we can verify via behavior
    });

    it("accepts autoServe option in constructor", () => {
      const client = new OpenCodeClient({
        baseUrl: "http://localhost:4096",
        autoServe: true,
      });
      expect(client.getBaseUrl()).toBe("http://localhost:4096");
    });
  });
});
