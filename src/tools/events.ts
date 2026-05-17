/**
 * Event streaming tools — subscribe to real-time events from OpenCode.
 *
 * Phase C (MEK-297 + MEK-289): migrated to use the typed SDK `
 * sdk.event.subscribe()` via the optional `sdkFactory` parameter.  Each
 * handler calls `sdkFactory?.(directory)` to obtain a per-directory SDK
 * client, because `createCoworkClient` bakes `directory` into the
 * customFetch closure at construction time (see sdk-adapter.ts:180+222).
 *
 * When `sdkFactory` is undefined (tests, legacy consumers), the handler
 * falls back to the legacy `OpenCodeClient.subscribeSSE("/event", {...})`
 * method, which propagates `directory` per-request via the `{directory}`
 * option.
 *
 * ## SDK gaps (v1 `@opencode-ai/sdk`)
 * - `sdk.event.subscribe()` has no `AbortSignal` parameter — the legacy
 *   `AbortController` pattern is replaced with `Promise.race` against a
 *   timeout deadline.  See `opencode_run_streaming` in workflow.ts for
 *   the reference implementation (commit 2c1d2ef).
 */

import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { OpenCodeClient } from "../client.js";
import type { OpencodeClient } from "@opencode-ai/sdk/client";
import { toolResult, toolError, directoryParam } from "../helpers.js";

export function registerEventTools(
  server: McpServer,
  client: OpenCodeClient,
  sdkFactory?: (directory?: string) => OpencodeClient,
) {
  server.tool(
    "opencode_events_poll",
    "Poll for recent events from the OpenCode server. Collects events for the specified duration and returns them. Useful for monitoring session activity, deployments, and system changes.",
    {
      durationMs: z
        .number()
        .optional()
        .describe(
          "How long to collect events in milliseconds (default: 3000, max: 30000)",
        ),
      maxEvents: z
        .number()
        .optional()
        .describe("Maximum number of events to collect (default: 50)"),
      directory: directoryParam,
    },
    async ({ durationMs, maxEvents, directory }) => {
      const sdk = sdkFactory?.(directory);
      try {
        const duration = Math.min(durationMs ?? 3000, 30000);
        const max = maxEvents ?? 50;
        const start = Date.now();

        // Normalized event format: { event: string, data: string }
        // — matches the legacy SSE pair so the formatter stays unchanged.
        const events: Array<{ event: string; data: string }> = [];

        if (sdk) {
          // ── SDK path: typed event.subscribe() ─────────────────────
          // sdk.event.subscribe() returns { stream: AsyncGenerator }
          // where each yielded item is a pre-parsed Event union member:
          // { type: "session.idle", properties: { sessionID: "ses_xxx" } }
          // No JSON.parse needed.  No AbortSignal — we use Promise.race
          // against the remaining timeout to bound the wait.
          const sse = await sdk.event.subscribe();
          const iter = sse.stream[Symbol.asyncIterator]();

          let remaining: number;
          while (events.length < max && (remaining = duration - (Date.now() - start)) > 0) {
            let result: IteratorResult<any>;
            try {
              result = await Promise.race([
                iter.next(),
                new Promise<never>((_, reject) =>
                  setTimeout(() => reject(new Error("SSE_TIMEOUT")), remaining),
                ),
              ]);
            } catch {
              break; // timeout or stream error
            }
            if (result.done) break;

            const parsed = result.value;
            // Normalize SDK Event — { type, properties } — to the legacy
            // { event, data } pair so the formatter below is identical.
            events.push({
              event: parsed.type ?? "unknown",
              data: JSON.stringify(parsed),
            });
          }
        } else {
          // ── Legacy path: raw SSE via client.subscribeSSE ─────────
          const controller = new AbortController();
          const timeout = setTimeout(() => controller.abort(), duration);

          try {
            for await (const evt of client.subscribeSSE("/event", { signal: controller.signal, directory })) {
              events.push(evt);
              if (events.length >= max) break;
              if (controller.signal.aborted) break;
            }
          } catch {
            // SSE connection will error when aborted — that's expected
          } finally {
            clearTimeout(timeout);
          }
        }

        if (events.length === 0) {
          return toolResult("No events received during the polling period.");
        }

        const formatted = events
          .map((e) => {
            try {
              const parsed = JSON.parse(e.data);
              return `[${e.event}] ${JSON.stringify(parsed, null, 2)}`;
            } catch {
              return `[${e.event}] ${e.data}`;
            }
          })
          .join("\n\n");

        return toolResult(
          `Collected ${events.length} event(s):\n\n${formatted}`,
        );
      } catch (e) {
        return toolError(e);
      }
    },
  );
}
