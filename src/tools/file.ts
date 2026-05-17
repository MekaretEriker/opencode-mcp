/**
 * File tools — find text, find files, find symbols, list directory, read file
 * content, check VCS file status.
 *
 * Phase C (MEK-297 + MEK-289): migrated to use typed SDK methods via the
 * optional `sdkFactory` parameter.  Each handler calls
 * `sdkFactory?.(directory)` to obtain a per-directory SDK client, because
 * `createCoworkClient` bakes `directory` into the customFetch closure at
 * construction time (see sdk-adapter.ts:180+222).  When `sdkFactory` is
 * undefined (tests, legacy consumers), the handler falls back to the
 * legacy `OpenCodeClient.get` methods, which propagate `directory`
 * per-request via the `{directory}` option.
 *
 * All 6 tools mapped to typed SDK methods — one partial gap:
 * - `sdk.find.text()`      → GET  /find
 * - `sdk.find.files()`     → GET  /find/file (SDK types omit `searchDirectory`
 *   and `limit` query params; legacy fallback handles full param set)
 * - `sdk.find.symbols()`   → GET  /find/symbol
 * - `sdk.file.list()`      → GET  /file
 * - `sdk.file.read()`      → GET  /file/content
 * - `sdk.file.status()`    → GET  /file/status
 *
 * SDK types handled correctly:
 * - `FindTextData`        — query.pattern only (directory handled by factory)
 * - `FindFilesData`       — query.query + query.dirs (directory handled by factory)
 * - `FindSymbolsData`     — query.query only (directory handled by factory)
 * - `FileListData`        — query.path only (directory handled by factory)
 * - `FileReadData`        — query.path only (directory handled by factory)
 * - `FileStatusData`      — no required params (directory handled by factory)
 */

import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { OpenCodeClient } from "../client.js";
import type { OpencodeClient } from "@opencode-ai/sdk/client";
import { toolJson, toolError, toolResult, directoryParam, readOnly } from "../helpers.js";

export function registerFileTools(
  server: McpServer,
  client: OpenCodeClient,
  sdkFactory?: (directory?: string) => OpencodeClient,
) {
  server.tool(
    "opencode_find_text",
    "Search for text patterns in project files (regex supported). Returns file paths, line numbers, and matching lines.",
    {
      pattern: z
        .string()
        .describe("Text or regex pattern to search for in files"),
      directory: directoryParam,
    },
    readOnly,
    async ({ pattern, directory }) => {
      const sdk = sdkFactory?.(directory);
      try {
        const raw = sdk
          ? (await sdk.find.text({ query: { pattern } })).data
          : await client.get("/find", { pattern }, directory);
        const results = Array.isArray(raw) ? raw as Array<Record<string, unknown>> : [];
        if (results.length === 0) {
          return toolResult(`No matches found for pattern: ${pattern}`);
        }
        const formatted = results.map((r) => {
          // The API returns path as {text: "file.ts"} and lines as {text: "content\n"}
          const rawPath = r.path ?? r.file ?? r.name ?? "";
          const filePath = typeof rawPath === "string"
            ? rawPath
            : (rawPath as Record<string, unknown>)?.text ?? (rawPath as Record<string, unknown>)?.path ?? (rawPath as Record<string, unknown>)?.name ?? String(rawPath);
          const lineNum = r.line_number ?? r.lineNumber ?? r.line ?? "?";
          const rawLines = r.lines ?? r.text ?? r.content ?? "";
          const lineText = typeof rawLines === "string"
            ? rawLines.trim()
            : (rawLines as Record<string, unknown>)?.text != null
              ? String((rawLines as Record<string, unknown>).text).trim()
              : JSON.stringify(rawLines);
          return `${filePath}:${lineNum}  ${lineText}`;
        }).join("\n");
        return toolResult(`${results.length} match(es):\n\n${formatted}`);
      } catch (e) {
        return toolError(e);
      }
    },
  );

  server.tool(
    "opencode_find_file",
    "Find files and directories by name (fuzzy match)",
    {
      query: z.string().describe("Search string for file/directory names"),
      type: z
        .enum(["file", "directory"])
        .optional()
        .describe("Limit results to 'file' or 'directory'"),
      searchDirectory: z
        .string()
        .optional()
        .describe("Override the project root for the search"),
      limit: z
        .number()
        .optional()
        .describe("Max number of results (1-200)"),
      directory: directoryParam,
    },
    readOnly,
    async ({ query, type, searchDirectory, limit, directory }) => {
      const sdk = sdkFactory?.(directory);
      try {
        // SDK gap: FindFilesData only types `query.query` and `query.dirs` —
        // `searchDirectory` and `limit` are not in the SDK type. Fall back
        // to legacy client when those extra params are used.
        // (https://opencode.ai/docs/sdk.md)
        if (sdk && !searchDirectory && limit === undefined) {
          const sdkQ: { query: string; dirs?: "true" | "false" } = { query };
          if (type === "directory") sdkQ.dirs = "true";
          const files = (await sdk.find.files({ query: sdkQ })).data as string[];
          if (!files || files.length === 0) {
            return toolResult(`No files found matching: ${query}`);
          }
          return toolResult(files.join("\n"));
        }

        const q: Record<string, string> = { query };
        if (type) q.type = type;
        if (searchDirectory) q.directory = searchDirectory;
        if (limit !== undefined) q.limit = String(limit);
        const files = (await client.get("/find/file", q, directory)) as string[];
        if (!files || files.length === 0) {
          return toolResult(`No files found matching: ${query}`);
        }
        return toolResult(files.join("\n"));
      } catch (e) {
        return toolError(e);
      }
    },
  );

  server.tool(
    "opencode_find_symbol",
    "Find workspace symbols by name (functions, classes, variables, etc.)",
    {
      query: z.string().describe("Symbol name to search for"),
      directory: directoryParam,
    },
    readOnly,
    async ({ query, directory }) => {
      const sdk = sdkFactory?.(directory);
      try {
        const raw = sdk
          ? (await sdk.find.symbols({ query: { query } })).data
          : await client.get("/find/symbol", { query }, directory);
        const symbols = Array.isArray(raw) ? raw as Array<Record<string, unknown>> : [];
        if (symbols.length === 0) {
          return toolResult(`No symbols found matching: ${query}`);
        }
        const lines = symbols.map((s) => {
          const name = s.name ?? s.symbol ?? "?";
          const kind = s.kind ? ` (${s.kind})` : "";
          const loc = s.location ?? s.path ?? s.file ?? "";
          const line = s.line ?? s.lineNumber ?? "";
          const locStr = loc ? ` — ${loc}${line ? `:${line}` : ""}` : "";
          return `- ${name}${kind}${locStr}`;
        });
        return toolResult(`${symbols.length} symbol(s) matching "${query}":\n\n${lines.join("\n")}`);
      } catch (e) {
        return toolError(e);
      }
    },
  );

  server.tool(
    "opencode_file_list",
    "List files and directories at a path",
    {
      path: z
        .string()
        .optional()
        .describe("Path to list (defaults to project root)"),
      directory: directoryParam,
    },
    readOnly,
    async ({ path, directory }) => {
      const sdk = sdkFactory?.(directory);
      try {
        const nodes = sdk
          ? (await sdk.file.list({ query: { path: path || "." } })).data as Array<Record<string, unknown>>
          : (await client.get("/file", { path: path || "." }, directory)) as Array<Record<string, unknown>>;
        if (!nodes || nodes.length === 0) {
          return toolResult("Empty directory.");
        }
        const formatted = nodes.map((n) => {
          const type = n.type === "directory" ? "[DIR]" : "     ";
          return `${type} ${n.name ?? n.path ?? "?"}`;
        }).join("\n");
        return toolResult(formatted);
      } catch (e) {
        return toolError(e);
      }
    },
  );

  server.tool(
    "opencode_file_read",
    "Read the content of a file",
    {
      path: z.string().describe("File path to read"),
      directory: directoryParam,
    },
    readOnly,
    async ({ path, directory }) => {
      const sdk = sdkFactory?.(directory);
      try {
        const result = sdk
          ? (await sdk.file.read({ query: { path } })).data as Record<string, unknown>
          : (await client.get("/file/content", { path }, directory)) as Record<string, unknown>;
        if (typeof result.content === "string") {
          return toolResult(`File: ${path}\n\n${result.content}`);
        }
        return toolJson(result);
      } catch (e) {
        return toolError(e);
      }
    },
  );

  server.tool(
    "opencode_file_status",
    "Get status for tracked files (VCS changes: modified, added, deleted, etc.)",
    {
      directory: directoryParam,
    },
    readOnly,
    async ({ directory }) => {
      const sdk = sdkFactory?.(directory);
      try {
        const files = sdk
          ? (await sdk.file.status()).data as Array<Record<string, unknown>>
          : (await client.get("/file/status", undefined, directory)) as Array<Record<string, unknown>>;
        if (!files || files.length === 0) {
          return toolResult("No tracked file changes.");
        }
        const formatted = files.map((f) => {
          const status = f.status ?? f.type ?? "?";
          const path = f.path ?? f.file ?? "?";
          return `[${status}] ${path}`;
        }).join("\n");
        return toolResult(formatted);
      } catch (e) {
        return toolError(e);
      }
    },
  );
}
