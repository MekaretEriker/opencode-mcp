/**
 * Session lifecycle tools — list, create, get, delete, update, fork, share, abort,
 * revert, summarize, init, todo, status, children, diff, permissions, search.
 *
 * Phase C (MEK-297 + MEK-289): migrated to use typed SDK methods via the
 * optional `sdkFactory` parameter.  Each handler calls
 * `sdkFactory?.(directory)` to obtain a per-directory SDK client, because
 * `createCoworkClient` bakes `directory` into the customFetch closure at
 * construction time (see sdk-adapter.ts:180+222).  A global cache in
 * `src/index.ts` ensures equivalent directories share a client instance.
 *
 * When `sdkFactory` is undefined (tests, legacy consumers), the handler
 * falls back to the legacy `OpenCodeClient.post/get/delete/patch` methods,
 * which propagate `directory` per-request via the `{directory}` option.
 *
 * All 18 tools mapped to typed SDK methods — two SDK gaps:
 * - `sdk.session.list()`          → GET  /session
 * - `sdk.session.create()`        → POST /session
 * - `sdk.session.get()`           → GET  /session/{id}
 * - `sdk.session.delete()`        → DELETE /session/{id}
 * - `sdk.session.update()`        → PATCH /session/{id}
 * - `sdk.session.children()`      → GET  /session/{id}/children
 * - `sdk.session.status()`        → GET  /session/status
 * - `sdk.session.todo()`          → GET  /session/{id}/todo
 * - `sdk.session.init()`          → POST /session/{id}/init
 * - `sdk.session.abort()`         → POST /session/{id}/abort
 * - `sdk.session.fork()`          → POST /session/{id}/fork
 * - `sdk.session.share()`         → POST /session/{id}/share
 * - `sdk.session.unshare()`       → DELETE /session/{id}/share
 * - `sdk.session.diff()`          → GET  /session/{id}/diff
 * - `sdk.session.summarize()`     → POST /session/{id}/summarize
 * - `sdk.session.revert()`        → POST /session/{id}/revert
 * - `sdk.session.unrevert()`      → POST /session/{id}/unrevert
 * - `sdk.postSessionIdPermissionsPermissionId()` → POST /session/{id}/permissions/{permissionID}
 *
 * SDK gaps (kept as raw `client.x()` with fallback):
 * - GET /permission          — no SDK method for listing pending permission requests
 *   (https://opencode.ai/docs/sdk.md). Kept as `client.get("/permission")` in
 *   `permission_list`.
 */

import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { OpenCodeClient } from "../client.js";
import type { OpencodeClient } from "@opencode-ai/sdk/client";
import { toolError, formatSessionList, formatDiffResponse, resolveSessionStatus, toolResult, directoryParam, destructive, readOnly } from "../helpers.js";

/** Format a single session object into a compact human-readable summary. */
function formatSession(raw: unknown): string {
  const s = raw as Record<string, unknown>;
  if (!s || typeof s !== "object") return JSON.stringify(raw);
  const lines: string[] = [];
  if (s.id) lines.push(`ID: ${s.id}`);
  if (s.title) lines.push(`Title: ${s.title}`);
  if (s.slug) lines.push(`Slug: ${s.slug}`);
  if (s.parentID) lines.push(`Parent: ${s.parentID}`);
  // Time field may be {created, updated} timestamps (ms since epoch)
  const time = s.time as Record<string, unknown> | undefined;
  if (time?.created) {
    lines.push(`Created: ${new Date(time.created as number).toISOString()}`);
  } else if (s.createdAt) {
    lines.push(`Created: ${s.createdAt}`);
  }
  if (time?.updated) {
    lines.push(`Updated: ${new Date(time.updated as number).toISOString()}`);
  } else if (s.updatedAt) {
    lines.push(`Updated: ${s.updatedAt}`);
  }
  if (s.status) lines.push(`Status: ${s.status}`);
  if (s.version) lines.push(`Version: ${s.version}`);
  if (s.directory) lines.push(`Directory: ${s.directory}`);
  if (s.shareUrl) lines.push(`Share URL: ${s.shareUrl}`);
  // Show summary if present
  const summary = s.summary as Record<string, unknown> | string | undefined;
  if (summary) {
    const text = typeof summary === "string" ? summary : (summary as Record<string, unknown>)?.text;
    if (text) lines.push(`Summary: ${String(text).slice(0, 200)}`);
  }
  return lines.length > 0 ? lines.join("\n") : JSON.stringify(raw);
}

export function registerSessionTools(
  server: McpServer,
  client: OpenCodeClient,
  sdkFactory?: (directory?: string) => OpencodeClient,
) {
  server.tool(
    "opencode_session_list",
    "List all sessions",
    {
      directory: directoryParam,
    },
    readOnly,
    async ({ directory }) => {
      const sdk = sdkFactory?.(directory);
      try {
        const sessions = sdk
          ? (await sdk.session.list()).data as unknown[]
          : (await client.get("/session", undefined, directory)) as Array<Record<string, unknown>>;
        return toolResult(formatSessionList(sessions));
      } catch (e) {
        return toolError(e);
      }
    },
  );

  server.tool(
    "opencode_session_create",
    "Create a new session. Optionally provide a parentID to create a child session, and a title.",
    {
      parentID: z.string().optional().describe("Parent session ID"),
      title: z.string().optional().describe("Session title"),
      directory: directoryParam,
    },
    async ({ parentID, title, directory }) => {
      const sdk = sdkFactory?.(directory);
      try {
        const body: Record<string, string> = {};
        if (parentID) body.parentID = parentID;
        if (title) body.title = title;
        const session = sdk
          ? (await sdk.session.create({ body })).data
          : await client.post("/session", body, { directory });
        return toolResult(`Session created.\n\n${formatSession(session)}`);
      } catch (e) {
        return toolError(e);
      }
    },
  );

  server.tool(
    "opencode_session_get",
    "Get details of a specific session by ID",
    {
      id: z.string().describe("Session ID"),
      directory: directoryParam,
    },
    readOnly,
    async ({ id, directory }) => {
      const sdk = sdkFactory?.(directory);
      try {
        const session = sdk
          ? (await sdk.session.get({ path: { id } })).data
          : await client.get(`/session/${id}`, undefined, directory);
        return toolResult(formatSession(session));
      } catch (e) {
        return toolError(e);
      }
    },
  );

  server.tool(
    "opencode_session_delete",
    "Delete a session and all its data",
    {
      id: z.string().describe("Session ID to delete"),
      directory: directoryParam,
    },
    destructive,
    async ({ id, directory }) => {
      const sdk = sdkFactory?.(directory);
      try {
        if (sdk) {
          await sdk.session.delete({ path: { id } });
        } else {
          await client.delete(`/session/${id}`, undefined, directory);
        }
        return toolResult(`Session ${id} deleted.`);
      } catch (e) {
        return toolError(e);
      }
    },
  );

  server.tool(
    "opencode_session_update",
    "Update session properties (e.g. title)",
    {
      id: z.string().describe("Session ID"),
      title: z.string().optional().describe("New title for the session"),
      directory: directoryParam,
    },
    async ({ id, title, directory }) => {
      const sdk = sdkFactory?.(directory);
      try {
        const body: Record<string, string> = {};
        if (title !== undefined) body.title = title;
        const updated = sdk
          ? (await sdk.session.update({ path: { id }, body })).data
          : await client.patch(`/session/${id}`, body, directory);
        return toolResult(formatSession(updated));
      } catch (e) {
        return toolError(e);
      }
    },
  );

  server.tool(
    "opencode_session_children",
    "Get child sessions of a session",
    {
      id: z.string().describe("Parent session ID"),
      directory: directoryParam,
    },
    readOnly,
    async ({ id, directory }) => {
      const sdk = sdkFactory?.(directory);
      try {
        const children = sdk
          ? (await sdk.session.children({ path: { id } })).data as unknown[]
          : (await client.get(`/session/${id}/children`, undefined, directory)) as unknown[];
        if (!children || !Array.isArray(children) || children.length === 0) {
          return toolResult("No child sessions found.");
        }
        return toolResult(formatSessionList(children));
      } catch (e) {
        return toolError(e);
      }
    },
  );

  server.tool(
    "opencode_session_status",
    "Get status for all sessions (running, idle, etc.)",
    {
      directory: directoryParam,
    },
    readOnly,
    async ({ directory }) => {
      const sdk = sdkFactory?.(directory);
      try {
        const raw = sdk
          ? (await sdk.session.status()).data
          : await client.get("/session/status", undefined, directory);
        const statuses = raw && typeof raw === "object" && !Array.isArray(raw)
          ? raw as Record<string, unknown>
          : {};
        const entries = Object.entries(statuses);
        if (entries.length === 0) {
          return toolResult("All sessions idle.");
        }
        const lines = entries.map(([id, status]) => `- ${id}: ${resolveSessionStatus(status)}`);
        return toolResult(`## Session Status (${entries.length})\n${lines.join("\n")}`);
      } catch (e) {
        return toolError(e);
      }
    },
  );

  server.tool(
    "opencode_session_todo",
    "Get the todo list for a session",
    {
      id: z.string().describe("Session ID"),
      directory: directoryParam,
    },
    readOnly,
    async ({ id, directory }) => {
      const sdk = sdkFactory?.(directory);
      try {
        const raw = sdk
          ? (await sdk.session.todo({ path: { id } })).data
          : await client.get(`/session/${id}/todo`, undefined, directory);
        const todos = Array.isArray(raw) ? raw as Array<Record<string, unknown>> : [];
        if (todos.length === 0) {
          return toolResult("No todos for this session.");
        }
        const lines = todos.map((t) => {
          const done = t.status === "completed" || t.done === true || t.completed === true;
          const check = done ? "[x]" : "[ ]";
          const content = t.content ?? t.title ?? t.text ?? t.description ?? "?";
          const priority = t.priority ? ` (${t.priority})` : "";
          return `- ${check} ${content}${priority}`;
        });
        const completed = todos.filter((t) => t.status === "completed" || t.done === true || t.completed === true).length;
        return toolResult(`## Todos (${completed}/${todos.length} done)\n${lines.join("\n")}`);
      } catch (e) {
        return toolError(e);
      }
    },
  );

  server.tool(
    "opencode_session_init",
    "Analyze the app and create AGENTS.md for a session. NOTE: This is a long-running operation that may take 30-60+ seconds depending on project size.",
    {
      id: z.string().describe("Session ID"),
      messageID: z.string().describe("Message ID"),
      providerID: z.string().describe("Provider ID (e.g. 'anthropic')"),
      modelID: z.string().describe("Model ID (e.g. 'claude-3-5-sonnet-20241022')"),
      variant: z.string().optional().describe("Model variant (e.g. 'fast', 'smart')"),
      directory: directoryParam,
    },
    async ({ id, messageID, providerID, modelID, variant, directory }) => {
      const sdk = sdkFactory?.(directory);
      try {
        const body: Record<string, string | undefined> = { messageID, providerID, modelID, variant };
        if (sdk) {
          // SDK body shape omits `variant` — pass minimal shape to avoid type errors
          await sdk.session.init({ path: { id }, body: { messageID, providerID, modelID } });
        } else {
          await client.post(`/session/${id}/init`, body, { directory });
        }
        return toolResult("AGENTS.md initialization started.");
      } catch (e) {
        return toolError(e);
      }
    },
  );

  server.tool(
    "opencode_session_abort",
    "Abort a running session",
    {
      id: z.string().describe("Session ID to abort"),
      directory: directoryParam,
    },
    async ({ id, directory }) => {
      const sdk = sdkFactory?.(directory);
      try {
        if (sdk) {
          await sdk.session.abort({ path: { id } });
        } else {
          await client.post(`/session/${id}/abort`, undefined, { directory });
        }
        return toolResult(`Session ${id} aborted.`);
      } catch (e) {
        return toolError(e);
      }
    },
  );

  server.tool(
    "opencode_session_fork",
    "Fork an existing session, optionally at a specific message",
    {
      id: z.string().describe("Session ID to fork"),
      messageID: z.string().optional().describe("Message ID to fork at (optional)"),
      directory: directoryParam,
    },
    async ({ id, messageID, directory }) => {
      const sdk = sdkFactory?.(directory);
      try {
        const body: Record<string, string> = {};
        if (messageID) body.messageID = messageID;
        const forked = sdk
          ? (await sdk.session.fork({ path: { id }, body })).data
          : await client.post(`/session/${id}/fork`, body, { directory });
        return toolResult(`Session forked.\n\n${formatSession(forked)}`);
      } catch (e) {
        return toolError(e);
      }
    },
  );

  server.tool(
    "opencode_session_share",
    "Share a session publicly",
    {
      id: z.string().describe("Session ID to share"),
      directory: directoryParam,
    },
    async ({ id, directory }) => {
      const sdk = sdkFactory?.(directory);
      try {
        const result = sdk
          ? (await sdk.session.share({ path: { id } })).data
          : await client.post(`/session/${id}/share`, undefined, { directory });
        const r = result as Record<string, unknown>;
        // API may return share URL in different locations
        const shareUrl = r.shareUrl ?? (r.share as Record<string, unknown> | undefined)?.url ?? null;
        const header = shareUrl ? `Session shared.\nURL: ${shareUrl}` : "Session shared.";
        return toolResult(`${header}\n\n${formatSession(result)}`);
      } catch (e) {
        return toolError(e);
      }
    },
  );

  server.tool(
    "opencode_session_unshare",
    "Unshare a previously shared session",
    {
      id: z.string().describe("Session ID to unshare"),
      directory: directoryParam,
    },
    async ({ id, directory }) => {
      const sdk = sdkFactory?.(directory);
      try {
        if (sdk) {
          await sdk.session.unshare({ path: { id } });
        } else {
          await client.delete(`/session/${id}/share`, undefined, directory);
        }
        return toolResult(`Session ${id} unshared.`);
      } catch (e) {
        return toolError(e);
      }
    },
  );

  server.tool(
    "opencode_session_diff",
    "Get the diff for a session, optionally for a specific message",
    {
      id: z.string().describe("Session ID"),
      messageID: z.string().optional().describe("Message ID (optional)"),
      directory: directoryParam,
    },
    async ({ id, messageID, directory }) => {
      const sdk = sdkFactory?.(directory);
      try {
        const query: Record<string, string> = {};
        if (messageID) query.messageID = messageID;
        const diffs = sdk
          ? (await sdk.session.diff({ path: { id }, query: Object.keys(query).length > 0 ? { messageID: query.messageID } : undefined })).data
          : await client.get(`/session/${id}/diff`, query, directory);
        return toolResult(formatDiffResponse(diffs as unknown[]));
      } catch (e) {
        return toolError(e);
      }
    },
  );

  server.tool(
    "opencode_session_summarize",
    "Summarize a session using a specified model. NOTE: This is a long-running operation that may take 30-60+ seconds.",
    {
      id: z.string().describe("Session ID"),
      providerID: z.string().describe("Provider ID (e.g. 'anthropic')"),
      modelID: z.string().describe("Model ID (e.g. 'claude-3-5-sonnet-20241022')"),
      variant: z.string().optional().describe("Model variant (e.g. 'fast', 'smart')"),
      directory: directoryParam,
    },
    async ({ id, providerID, modelID, variant, directory }) => {
      const sdk = sdkFactory?.(directory);
      try {
        if (sdk) {
          // SDK body shape omits `variant` — pass minimal shape to avoid type errors
          await sdk.session.summarize({ path: { id }, body: { providerID, modelID } });
        } else {
          await client.post(`/session/${id}/summarize`, { providerID, modelID, variant }, { directory });
        }
        return toolResult("Session summarization started.");
      } catch (e) {
        return toolError(e);
      }
    },
  );

  server.tool(
    "opencode_session_revert",
    "Revert a message in a session",
    {
      id: z.string().describe("Session ID"),
      messageID: z.string().describe("Message ID to revert"),
      partID: z.string().optional().describe("Part ID to revert (optional)"),
      directory: directoryParam,
    },
    async ({ id, messageID, partID, directory }) => {
      const sdk = sdkFactory?.(directory);
      try {
        const body: Record<string, string> = { messageID };
        if (partID) body.partID = partID;
        if (sdk) {
          await sdk.session.revert({ path: { id }, body: body as { messageID: string; partID?: string } });
        } else {
          await client.post(`/session/${id}/revert`, body, { directory });
        }
        return toolResult(`Message ${messageID} reverted.`);
      } catch (e) {
        return toolError(e);
      }
    },
  );

  server.tool(
    "opencode_session_unrevert",
    "Restore all reverted messages in a session",
    {
      id: z.string().describe("Session ID"),
      directory: directoryParam,
    },
    async ({ id, directory }) => {
      const sdk = sdkFactory?.(directory);
      try {
        if (sdk) {
          await sdk.session.unrevert({ path: { id } });
        } else {
          await client.post(`/session/${id}/unrevert`, undefined, { directory });
        }
        return toolResult("All reverted messages restored.");
      } catch (e) {
        return toolError(e);
      }
    },
  );

  // ─── Permission: list pending ─────────────────────────────────────────
  server.tool(
    "opencode_permission_list",
    "List all pending permission requests across all sessions. When a session is blocked waiting for approval (e.g. to run a shell command or access a file outside the project), it appears here. Respond with `opencode_session_permission`.",
    {
      directory: directoryParam,
    },
    readOnly,
    async ({ directory }) => {
      // SDK gap: no `sdk.session.permission.list()` in @opencode-ai/sdk v1
      // (https://opencode.ai/docs/sdk.md). Kept as raw client.get("/permission").
      try {
        const requests = (await client.get("/permission", undefined, directory)) as Array<Record<string, unknown>>;
        if (!requests || !Array.isArray(requests) || requests.length === 0) {
          return toolResult("No pending permission requests.");
        }

        const lines = requests.map((r) => {
          const id = r.id ?? "?";
          const session = r.sessionID ?? "?";
          const perm = r.permission ?? "?";
          const patterns = Array.isArray(r.patterns) ? (r.patterns as string[]).join(", ") : "";
          const tool = r.tool as Record<string, unknown> | undefined;
          const toolName = tool?.name ?? tool?.tool ?? "";
          let line = `- **${perm}** [${id}] (session: ${session})`;
          if (toolName) line += `\n  Tool: ${toolName}`;
          if (patterns) line += `\n  Patterns: ${patterns}`;
          // Show what "always" would approve
          const always = Array.isArray(r.always) ? (r.always as string[]).join(", ") : "";
          if (always) line += `\n  Always would approve: ${always}`;
          return line;
        });

        return toolResult(
          `## Pending Permission Requests (${requests.length})\n\n` +
          lines.join("\n\n") +
          `\n\nRespond with: \`opencode_session_permission({id: "SESSION_ID", permissionID: "PERM_ID", reply: "once"|"always"|"reject"})\``
        );
      } catch (e) {
        return toolError(e);
      }
    },
  );

  // ─── Permission: respond ──────────────────────────────────────────────
  server.tool(
    "opencode_session_permission",
    "Respond to a permission request in a session. Use `opencode_permission_list` to see pending requests. Reply values: 'once' (approve this request only), 'always' (approve this + future matching requests for this session), 'reject' (deny the request).",
    {
      id: z.string().describe("Session ID"),
      permissionID: z.string().describe("Permission request ID"),
      reply: z.enum(["once", "always", "reject"]).describe("Response to the permission request: 'once' to approve once, 'always' to auto-approve matching future requests, 'reject' to deny"),
      directory: directoryParam,
    },
    async ({ id, permissionID, reply, directory }) => {
      const sdk = sdkFactory?.(directory);
      try {
        // Try the new API first (POST /permission/{requestID}/reply)
        // SDK gap: no `sdk.permission.reply()` method in @opencode-ai/sdk v1
        // (https://opencode.ai/docs/sdk.md). Kept as raw client.post().
        try {
          await client.post(`/permission/${permissionID}/reply`, { reply }, { directory });
          return toolResult(`Permission ${reply === "reject" ? "rejected" : "approved"} (${reply}).`);
        } catch {
          // Fall back to the session-scoped permission endpoint (SDK or legacy)
          if (sdk) {
            await sdk.postSessionIdPermissionsPermissionId({
              path: { id, permissionID },
              body: { response: reply },
            });
          } else {
            await client.post(`/session/${id}/permissions/${permissionID}`, { response: reply }, { directory });
          }
          return toolResult(`Permission ${reply === "reject" ? "rejected" : "approved"} (${reply}).`);
        }
      } catch (e) {
        return toolError(e);
      }
    },
  );

  // ─── Session search ─────────────────────────────────────────────────
  server.tool(
    "opencode_session_search",
    "Search sessions by keyword in title. Useful for finding a specific session among many.",
    {
      query: z.string().describe("Search keyword (case-insensitive match on session title)"),
      directory: directoryParam,
    },
    readOnly,
    async ({ query, directory }) => {
      const sdk = sdkFactory?.(directory);
      try {
        const sessions = sdk
          ? (await sdk.session.list()).data as Array<Record<string, unknown>>
          : (await client.get("/session", undefined, directory)) as Array<Record<string, unknown>>;
        if (!sessions || sessions.length === 0) {
          return toolResult("No sessions found.");
        }

        const q = query.toLowerCase();
        const matches = sessions.filter((s) => {
          const title = ((s.title ?? "") as string).toLowerCase();
          const id = ((s.id ?? "") as string).toLowerCase();
          return title.includes(q) || id.includes(q);
        });

        if (matches.length === 0) {
          return toolResult(`No sessions matching: "${query}"\n\nTotal sessions: ${sessions.length}. Use \`opencode_session_list\` to see all.`);
        }

        return toolResult(
          `## Sessions matching "${query}" (${matches.length}/${sessions.length})\n${formatSessionList(matches)}`,
        );
      } catch (e) {
        return toolError(e);
      }
    },
  );
}
