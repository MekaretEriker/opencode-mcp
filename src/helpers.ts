/**
 * Smart response formatting helpers.
 *
 * Instead of dumping raw JSON to the LLM, these helpers extract the
 * meaningful content from OpenCode API responses so the LLM can reason
 * about them efficiently.
 */

import { z } from "zod";
import { existsSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { OpenCodeError } from "./client.js";

/* eslint-disable @typescript-eslint/no-explicit-any */

// ── Tool Annotations ─────────────────────────────────────────────────
// MCP spec tool annotations help clients understand tool behavior.

/** Read-only tool: does not modify state. */
export const readOnly = { readOnlyHint: true, destructiveHint: false } as const;

/** Destructive tool: permanently deletes data or shuts down services. */
export const destructive = { readOnlyHint: false, destructiveHint: true } as const;

/**
 * Shared Zod parameter for project directory targeting.
 * When provided, sent as the x-opencode-directory header so the
 * OpenCode server scopes the request to that project.
 */
export const directoryParam = z
  .string()
  .optional()
  .describe(
    "Absolute path to the project directory. " +
      "When provided, the request targets that project. " +
      "If omitted, the OpenCode server uses its own working directory.",
  );

// ── Default Provider/Model ────────────────────────────────────────────

/**
 * Module-level defaults for provider and model.
 * Set via `setModelDefaults()` during startup from env vars.
 * If not set, tools fall back to whatever the OpenCode server decides.
 */
let _defaultProviderID: string | undefined;
let _defaultModelID: string | undefined;

/**
 * Set the global default provider and model.
 * Called once from index.ts during startup.
 */
export function setModelDefaults(providerID?: string, modelID?: string): void {
  _defaultProviderID = providerID;
  _defaultModelID = modelID;
}

/**
 * Apply model defaults: use explicit params if both are provided,
 * otherwise fall back to env-var defaults if both are set,
 * otherwise return undefined (let the server decide).
 *
 * Returns `{ providerID, modelID }` or `undefined`.
 */
export function applyModelDefaults(
  providerID?: string,
  modelID?: string,
  variant?: string,
): { providerID: string; modelID: string; variant?: string } | undefined {
  // Explicit params take priority
  if (providerID && modelID) {
    return { providerID, modelID, ...(variant ? { variant } : {}) };
  }
  // Fall back to env-var defaults
  if (_defaultProviderID && _defaultModelID) {
    return { providerID: _defaultProviderID, modelID: _defaultModelID, ...(variant ? { variant } : {}) };
  }
  // No defaults available — let the server decide
  return undefined;
}

// ── Directory Validation ─────────────────────────────────────────────

/**
 * Translate a Windows absolute path to its WSL equivalent.
 *   `C:\Users\foo` → `/mnt/c/Users/foo`
 *   `D:\Projects\opencode-mcp` → `/mnt/d/Projects/opencode-mcp`
 *
 * Pure string translation, no I/O. Returns the input unchanged if it
 * doesn't match a Windows drive-letter pattern. See MEK-289.
 */
export function windowsToWslPath(p: string): string {
  const m = /^([A-Za-z]):[\\/](.*)$/.exec(p);
  if (!m) return p;
  const [, drive, rest] = m;
  return `/mnt/${drive.toLowerCase()}/${rest.replace(/\\/g, "/")}`;
}

/**
 * Translate a WSL-style path to Windows form.
 *   `/mnt/c/Users/foo` → `C:\Users\foo`
 *   `/mnt/d/Projects/foo` → `D:\Projects\foo`
 *
 * Pure string translation, no I/O. Returns the input unchanged if it
 * doesn't match the `/mnt/<drive>/...` pattern. See MEK-289.
 */
export function wslToWindowsPath(p: string): string {
  const m = /^\/mnt\/([a-z])\/(.*)$/.exec(p);
  if (!m) return p;
  const [, drive, rest] = m;
  return `${drive.toUpperCase()}:\\${rest.replace(/\//g, "\\")}`;
}

/**
 * Translation mode for the directory header sent to the OpenCode server.
 * Configurable via env `OPENCODE_MCP_TRANSLATE_PATHS`:
 *   - `wsl`  : always translate Windows-style paths to `/mnt/<drive>/...`
 *   - `none` : never translate, ship the path as-is (legacy behavior)
 *   - `auto` (default) : translate iff the client process runs on Windows
 *
 * Default `auto` covers the most common Cowork deployment shape
 * (Cowork-on-Windows + OpenCode-in-WSL). See MEK-289.
 */
type PathTranslateMode = "wsl" | "none" | "auto";

function getPathTranslateMode(): PathTranslateMode {
  const v = process.env.OPENCODE_MCP_TRANSLATE_PATHS?.toLowerCase();
  if (v === "wsl" || v === "none" || v === "auto") return v as PathTranslateMode;
  return "auto";
}

/**
 * Server OS hint for cross-OS path validation.
 * Configurable via env `OPENCODE_MCP_SERVER_OS`:
 *   - `linux` | `win32` | `darwin`  — explicit override
 *   - `auto` (default) — infer from input shape and client OS
 *
 * When `auto`, paths that are unreachable from the client side but
 * valid on the server side (e.g. POSIX-only `/home/...` on a Windows
 * client targeting a Linux server) skip local `existsSync` validation
 * and are shipped verbatim. See #33.
 */
function getServerOsHint(): "linux" | "win32" | "darwin" | "auto" {
  const v = process.env.OPENCODE_MCP_SERVER_OS?.toLowerCase();
  if (v === "linux" || v === "win32" || v === "darwin" || v === "auto") return v;
  return "auto";
}

/**
 * Normalize and validate a directory path:
 *  - Accepts both POSIX and Windows absolute paths from the user
 *  - If client runs on Windows and a WSL-style input is provided, translates
 *    it to Windows form *before* local validation (existsSync on Windows
 *    cannot see `/mnt/d/...` directly)
 *  - Resolves to absolute (handles "..", ".", trailing slashes, and
 *    converts relative inputs against `process.cwd()`)
 *  - Confirms the resolved path is absolute for the current platform
 *  - Validates that the path exists on disk
 *  - Per `OPENCODE_MCP_TRANSLATE_PATHS` (default `auto`), translates the
 *    validated path to WSL form before returning, so the OpenCode server
 *    running in WSL/Linux receives a path it can actually use as cwd
 *
 * Cross-OS behavior (client/server asymmetry, #33):
 *
 * | input shape | client OS | server OS hint | action |
 * |---|---|---|---|
 * | `C:\\Users\\...` | win32 | auto / linux / darwin | local validation + translation (unchanged) |
 * | `/mnt/<d>/...` | win32 | auto / linux / darwin | wslToWindowsPath → local validation (unchanged) |
 * | `/home/...`, `/root/...`, `/tmp/...` | win32 | auto / linux / darwin | skip local validation, ship verbatim to server |
 * | any | non-win32 | auto | local validation (unchanged) |
 * | `C:\\Users\\...` | non-win32 | win32 | skip local validation, ship verbatim |
 *
 * Use `OPENCODE_MCP_SERVER_OS=linux|win32|darwin|auto` (default `auto`) to
 * override the server OS hint. `auto` infers from input shape and client OS
 * per the matrix above. The existing `OPENCODE_MCP_TRANSLATE_PATHS` env var
 * is an orthogonal concern and is not affected by this change.
 *
 * Returns the normalized path (in the form the server expects), or
 * undefined if input was undefined. Throws a descriptive Error on
 * validation failure.
 */
export function normalizeDirectory(directory?: string): string | undefined {
  if (!directory) return undefined;

  const clientOs = process.platform;
  const serverOs = getServerOsHint();
  const isWindowsDrive = /^[A-Za-z]:[\\/]/.test(directory);
  const isWslMount = /^\/mnt\/[a-z]\//.test(directory);
  const isPosixStyle = directory.startsWith("/");

  // Explicit serverOs=win32 on a non-win32 client: Windows paths are
  // unreachable from the client's filesystem, skip local validation
  // and ship verbatim. The server reports its own error if invalid.
  if (isWindowsDrive && clientOs !== "win32" && serverOs === "win32") {
    return directory;
  }

  // POSIX-only paths (starts with "/" but not a WSL mount) on a Windows
  // client: the server is a POSIX box (auto inference means the server
  // OS differs from the client, explicit linux/darwin confirms it).
  // These paths are unreachable from the Windows client — skip local
  // `existsSync` and ship verbatim. The server will report a clear
  // "no such directory" error if the path is invalid, which is strictly
  // better than the current cryptic Windows-side `C:\\home\\...` error.
  if (
    isPosixStyle &&
    !isWslMount &&
    clientOs === "win32" &&
    (serverOs === "auto" || serverOs === "linux" || serverOs === "darwin")
  ) {
    return directory;
  }

  // Accept WSL paths even on Windows clients. `existsSync` on Windows
  // can't see `/mnt/d/...` but can see `D:\...` — translate WSL → Windows
  // BEFORE local validation. MEK-289.
  const inputForValidation =
    clientOs === "win32" ? wslToWindowsPath(directory) : directory;

  // Resolve to an absolute, platform-appropriate form. `resolve` handles
  // "..", ".", trailing slashes, and will convert a relative input against
  // `process.cwd()`.
  const normalized = resolve(inputForValidation);

  // Defensive check: `resolve` guarantees an absolute path on every
  // supported platform, but we verify via the platform-aware `isAbsolute`
  // so callers get a clear error if that assumption is ever violated.
  if (!isAbsolute(normalized)) {
    throw new Error(
      `Invalid directory: "${directory}" is not an absolute path. ` +
        `Provide a full path like "/home/user/my-project" (POSIX) or ` +
        `"C:\\\\Users\\\\me\\\\my-project" (Windows).`,
    );
  }

  // Must exist on disk
  if (!existsSync(normalized)) {
    throw new Error(
      `Directory not found: "${normalized}" does not exist. ` +
        `Check the path and try again.`,
    );
  }

  // For the OpenCode server, translate Windows paths to WSL when required.
  // MEK-289 fix: previously the Windows path was shipped as-is in the
  // `x-opencode-directory` header, where a Linux server would `path.join`
  // it onto its cwd producing nonsense like
  // `/mnt/d/Projects/agent/D:\Projects\foo` — every subsequent tool call
  // that touched the filesystem silent-failed.
  const mode = getPathTranslateMode();
  const shouldTranslate =
    mode === "wsl" || (mode === "auto" && clientOs === "win32");

  return shouldTranslate ? windowsToWslPath(normalized) : normalized;
}

/**
 * Extract a human-readable summary from a message response.
 * Pulls text content from parts, summarizes tool calls, etc.
 * Accepts any shape — casts internally for safety.
 */
export function formatMessageResponse(response: unknown): string {
  const r = response as any;
  const sections: string[] = [];

  // Omit verbose message header for cleaner output; the caller (opencode_ask etc.)
  // already provides session context.  Keep a minimal role tag only when it adds info.

  if (r?.parts && Array.isArray(r.parts)) {
    for (const part of r.parts) {
      switch (part.type) {
        case "text":
          sections.push(part.text ?? part.content ?? "");
          break;
        case "tool-invocation":
        case "tool-result":
          sections.push(
            `[Tool: ${part.toolName ?? "unknown"}] ${part.error ? `ERROR: ${part.error}` : typeof part.output === "string" ? part.output : JSON.stringify(part.output ?? part.input, null, 2)}`,
          );
          break;
        case "step-start":
        case "step-finish":
          // Internal lifecycle events — omit from user-facing output.
          // Optionally surface cost/token info from step-finish.
          if (part.type === "step-finish" && (part.cost != null || part.tokens)) {
            const meta: string[] = [];
            if (part.cost != null) meta.push(`cost: $${Number(part.cost).toFixed(4)}`);
            if (part.tokens) {
              const t = part.tokens;
              const tokParts: string[] = [];
              if (t.input) tokParts.push(`${t.input} in`);
              if (t.output) tokParts.push(`${t.output} out`);
              if (t.reasoning) tokParts.push(`${t.reasoning} reasoning`);
              if (tokParts.length > 0) meta.push(`tokens: ${tokParts.join(", ")}`);
            }
            if (meta.length > 0) sections.push(`_${meta.join(" | ")}_`);
          }
          break;
        default:
          // Skip unknown internal part types to keep output clean
          if (part.text || part.content) {
            sections.push(part.text ?? part.content);
          }
          // Only dump JSON for truly unknown parts that have meaningful data
          else if (part.type && !["source"].includes(part.type)) {
            sections.push(
              `[${part.type}] ${JSON.stringify(part, null, 2)}`,
            );
          }
      }
    }
  }

  return sections.join("\n\n");
}

/**
 * Format a list of messages, extracting text content from each.
 *
 * When the assistant message has no text content (common with some providers
 * that only emit tool calls), we show a concise summary of tool actions
 * instead of blank output.  Cost/token metadata from step-finish parts is
 * appended when available.
 */
export function formatMessageList(
  messages: unknown[],
): string {
  if (!messages || messages.length === 0) return "No messages found.";

  return messages
    .map((raw, i) => {
      const msg = raw as any;
      const role = msg?.info?.role ?? "unknown";
      const id = msg?.info?.id ?? "?";
      const parts = Array.isArray(msg?.parts) ? msg.parts : [];

      const textParts = parts
        .filter((p: any) => p.type === "text")
        .map((p: any) => (p.text ?? p.content ?? "").trim())
        .filter(Boolean)
        .join("\n");

      const toolParts = parts.filter(
        (p: any) => p.type === "tool-invocation" || p.type === "tool-result",
      );

      // Extract cost/token metadata from step-finish parts
      const costMeta = extractCostMeta(parts);

      let summary = `--- Message ${i + 1} [${role}] (${id}) ---\n`;

      if (textParts) {
        summary += textParts;
        if (toolParts.length > 0) {
          summary += `\n[${toolParts.length} tool call(s)]`;
        }
      } else if (toolParts.length > 0) {
        // No text but agent performed actions — show concise tool summaries
        const toolSummaries = toolParts.slice(0, 10).map((p: any) => {
          const name = p.toolName ?? "unknown";
          // Extract the most useful arg (file path, command, etc.)
          const hint = summarizeToolInput(p.input);
          const errTag = p.error ? " ERROR" : "";
          return `  ${name}${hint ? `: ${hint}` : ""}${errTag}`;
        });
        summary += `Agent performed ${toolParts.length} action(s):\n${toolSummaries.join("\n")}`;
        if (toolParts.length > 10) {
          summary += `\n  ... and ${toolParts.length - 10} more`;
        }
      } else {
        summary += "(no content)";
      }

      if (costMeta) summary += `\n${costMeta}`;

      return summary;
    })
    .join("\n\n");
}

/**
 * Extract a short hint from a tool-call input object.
 * Prefers path, command, file, query — the most informative single arg.
 */
function summarizeToolInput(input: unknown): string {
  if (!input || typeof input !== "object") return "";
  const obj = input as Record<string, unknown>;
  // Ordered by likely usefulness
  for (const key of ["path", "filePath", "file", "command", "query", "url", "pattern", "text"]) {
    const val = obj[key];
    if (typeof val === "string" && val.length > 0) {
      return val.length > 80 ? val.slice(0, 77) + "..." : val;
    }
  }
  return "";
}

/**
 * Extract cost/token metadata from step-finish parts and return a
 * compact line, or empty string if none found.
 */
function extractCostMeta(parts: any[]): string {
  const stepFinish = parts.find(
    (p: any) => p.type === "step-finish" && (p.cost != null || p.tokens),
  );
  if (!stepFinish) return "";
  const meta: string[] = [];
  if (stepFinish.cost != null) meta.push(`cost: $${Number(stepFinish.cost).toFixed(4)}`);
  if (stepFinish.tokens) {
    const t = stepFinish.tokens;
    const tokParts: string[] = [];
    if (t.input) tokParts.push(`${t.input} in`);
    if (t.output) tokParts.push(`${t.output} out`);
    if (t.reasoning) tokParts.push(`${t.reasoning} reasoning`);
    if (tokParts.length > 0) meta.push(`tokens: ${tokParts.join(", ")}`);
  }
  return meta.length > 0 ? `_${meta.join(" | ")}_` : "";
}

/**
 * Format a diff response into a readable summary.
 */
export function formatDiffResponse(diffs: unknown[]): string {
  if (!diffs || diffs.length === 0) return "No changes found.";

  return diffs
    .map((d: unknown) => {
      const diff = d as Record<string, unknown>;
      const path = diff.path ?? diff.file ?? "unknown";
      const status = diff.status ?? diff.type ?? "";
      const additions =
        typeof diff.additions === "number" ? `+${diff.additions}` : "";
      const deletions =
        typeof diff.deletions === "number" ? `-${diff.deletions}` : "";
      const stats = [additions, deletions].filter(Boolean).join(" ");
      let line = `${status} ${path}`;
      if (stats) line += ` (${stats})`;
      if (typeof diff.diff === "string") {
        line += `\n${diff.diff}`;
      }
      return line;
    })
    .join("\n");
}

/**
 * Format session objects for LLM-friendly display.
 */
export function formatSessionList(
  sessions: unknown[],
): string {
  if (!sessions || sessions.length === 0) return "No sessions found.";

  return sessions
    .map((raw) => {
      const s = raw as any;
      const id = s?.id ?? "?";
      const title = s?.title ?? "(untitled)";
      const createdAt = s?.createdAt ?? "";
      const parentID = s?.parentID ? ` (child of ${s.parentID})` : "";
      return `- ${title} [${id}]${parentID}${createdAt ? ` created ${createdAt}` : ""}`;
    })
    .join("\n");
}

/**
 * Generic safe JSON stringify with truncation for very large responses.
 */
export function safeStringify(
  value: unknown,
  maxLength: number = 50000,
): string {
  const json = JSON.stringify(value, null, 2);
  if (json.length <= maxLength) return json;
  return (
    json.slice(0, maxLength) +
    `\n\n... [truncated, ${json.length - maxLength} more characters]`
  );
}

/**
 * Analyze an AI message response for signs of failure:
 *  - Completely empty (null/undefined)
 *  - Has parts but no text content (provider returned nothing)
 *  - Contains error indicators in parts
 *
 * Returns a diagnostic object with `isEmpty`, `hasError`, and `warning` text.
 */
export function analyzeMessageResponse(response: unknown): {
  isEmpty: boolean;
  hasError: boolean;
  warning: string | null;
  tokenUsage?: { prompt?: number; completion?: number; reasoning?: number };
  modelIdEffective?: string;
} {
  if (response === null || response === undefined) {
    return {
      isEmpty: true,
      hasError: false,
      warning:
        "The AI returned an empty response. This usually means the provider " +
        "is not configured or the API key is missing/invalid. " +
        "Use `opencode_setup` to check provider status, or " +
        "`opencode_auth_set` to configure an API key.",
    };
  }

  const r = response as any;
  const parts = Array.isArray(r?.parts) ? r.parts : [];

  // Extract token usage from step-finish parts (used on error paths)
  const tokenUsage = extractTokenUsage(parts);
  // Extract effective model ID from step-finish or part metadata
  const modelIdEffective = extractModelIdEffective(parts);

  // Check for error parts
  const errorParts = parts.filter(
    (p: any) =>
      p.error ||
      (p.type === "tool-result" && p.error) ||
      (typeof p.text === "string" && /\b(error|unauthorized|forbidden|invalid.?key)\b/i.test(p.text)),
  );
  if (errorParts.length > 0) {
    const firstError =
      errorParts[0].error ??
      errorParts[0].text ??
      JSON.stringify(errorParts[0]);
    return {
      isEmpty: false,
      hasError: true,
      warning:
        `The response contains an error: ${typeof firstError === "string" ? firstError : JSON.stringify(firstError)}. ` +
        "This may indicate an authentication issue. " +
        "Use `opencode_auth_set` to verify your API key.",
      tokenUsage,
      modelIdEffective,
    };
  }

  // Check if there's any actual text content
  const textContent = parts
    .filter((p: any) => p.type === "text")
    .map((p: any) => (p.text ?? p.content ?? "").trim())
    .join("");

  if (parts.length === 0 || textContent === "") {
    return {
      isEmpty: true,
      hasError: false,
      warning:
        "The AI returned a response with no text content. This usually means " +
        "the provider API key is missing or the model is unavailable. " +
        "Try a different provider/model, or use `opencode_auth_set` to configure credentials.",
      tokenUsage,
      modelIdEffective,
    };
  }

  return { isEmpty: false, hasError: false, warning: null, tokenUsage, modelIdEffective };
}

function extractTokenUsage(parts: any[]) {
  const stepFinish = parts.find(
    (p: any) => p.type === "step-finish" && p.tokens,
  );
  if (!stepFinish?.tokens) return undefined;
  const usage: { prompt?: number; completion?: number; reasoning?: number } = {};
  if (stepFinish.tokens.input != null) usage.prompt = stepFinish.tokens.input;
  if (stepFinish.tokens.output != null) usage.completion = stepFinish.tokens.output;
  if (stepFinish.tokens.reasoning != null) usage.reasoning = stepFinish.tokens.reasoning;
  return Object.keys(usage).length > 0 ? usage : undefined;
}

function extractModelIdEffective(parts: any[]): string | undefined {
  const stepFinish = parts.find((p: any) => p.type === "step-finish");
  if (stepFinish?.modelID) return stepFinish.modelID;
  for (const p of parts) {
    if (p.providerMetadata?.modelId) return p.providerMetadata.modelId;
    if (p.model) return p.model;
  }
  return undefined;
}

/**
 * Detect if a string value looks like an API key or secret token,
 * regardless of the key name it's stored under.
 */
const SECRET_VALUE_PREFIXES = /^(?:sk-|tvly-|ctx7sk-|pplx-|hf_|ghp_|gho_|ghu_|ghs_|ghr_|xoxb-|xoxp-|xapp-|whsec_|rk-|pk_live_|sk_live_|sk_test_|pk_test_|FLWSECK_|access_|bearer\s)/i;
const LONG_HEX_OR_BASE64 = /^[A-Za-z0-9+/=_-]{32,}$/;

function looksLikeSecret(val: string): boolean {
  if (val.length < 16) return false;
  if (SECRET_VALUE_PREFIXES.test(val)) return true;
  // Long alphanumeric strings without spaces (probable tokens)
  if (LONG_HEX_OR_BASE64.test(val) && !val.includes(" ")) return true;
  return false;
}

/**
 * Redact query-parameter values in a URL string that look like secrets.
 */
function redactUrlSecrets(url: string): string {
  try {
    const parsed = new URL(url);
    let changed = false;
    const sensitiveParamPattern = /(?:key|token|secret|password|credential|auth)/i;
    for (const [name, val] of parsed.searchParams.entries()) {
      if ((sensitiveParamPattern.test(name) && val.length > 8) || looksLikeSecret(val)) {
        parsed.searchParams.set(name, val.slice(0, 4) + "***REDACTED***");
        changed = true;
      }
    }
    return changed ? parsed.toString() : url;
  } catch {
    return url;
  }
}

/**
 * Redact values that look like API keys, tokens, or secrets.
 * Replaces the value with the first 4 characters + "***REDACTED***".
 * Works recursively on objects and arrays.
 *
 * Three layers of detection:
 * 1. Key-name based: key names matching sensitive patterns (KEY, TOKEN, SECRET, etc.)
 * 2. Value-based: string values matching known API key prefixes or long hex/base64 tokens
 * 3. URL-based: query parameters in URL strings that contain secrets
 */
export function redactSecrets(value: unknown): unknown {
  if (value === null || value === undefined) return value;

  if (typeof value === "string") return value;

  if (Array.isArray(value)) {
    return value.map((item) => {
      // Redact string items in arrays that look like secrets (e.g. command args)
      if (typeof item === "string" && looksLikeSecret(item)) {
        return item.slice(0, 4) + "***REDACTED***";
      }
      return redactSecrets(item);
    });
  }

  if (typeof value === "object") {
    const result: Record<string, unknown> = {};
    const sensitiveKeyPattern = /(?:key|token|secret|password|credential|api_key|apikey|auth)/i;
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (typeof v === "string") {
        if (v.length > 8 && sensitiveKeyPattern.test(k)) {
          // Layer 1: key-name match
          result[k] = v.slice(0, 4) + "***REDACTED***";
        } else if (looksLikeSecret(v)) {
          // Layer 2: value looks like a secret
          result[k] = v.slice(0, 4) + "***REDACTED***";
        } else if (v.includes("://") && v.includes("?")) {
          // Layer 3: URL with query params — redact secret params
          result[k] = redactUrlSecrets(v);
        } else {
          result[k] = v;
        }
      } else if (typeof v === "object" && v !== null) {
        result[k] = redactSecrets(v);
      } else {
        result[k] = v;
      }
    }
    return result;
  }

  return value;
}

/**
 * Determine whether a provider object from the OpenCode API is truly configured
 * (i.e. has usable credentials), as opposed to being a built-in default.
 *
 * Detection layers:
 *  - source "env" / "config" / "api" → always configured
 *  - source "custom" with a non-empty apiKey → configured
 *  - source "custom" for "anthropic" with extra option keys (OAuth sets headers) → configured
 *  - Everything else → not configured
 */
export function isProviderConfigured(p: Record<string, unknown>): boolean {
  const source = p.source as string | undefined;
  if (source === "env" || source === "config" || source === "api") return true;
  if (source === "custom") {
    const opts = p.options as Record<string, unknown> | undefined;
    if (typeof opts?.apiKey === "string" && opts.apiKey !== "") return true;
    // Anthropic heuristic: OAuth sets headers but no apiKey
    if (p.id === "anthropic" && opts && Object.keys(opts).some((k) => k !== "apiKey")) return true;
  }
  return false;
}

/**
 * Resolve a session status value from the OpenCode API.
 *
 * The API may return status as a plain string ("idle", "running") or as an
 * object like `{ state: "running", ... }`.  This helper normalises both forms
 * into a human-readable string.
 */
export function resolveSessionStatus(raw: unknown): string {
  if (raw === null || raw === undefined) return "idle";
  if (typeof raw === "string") return raw;
  if (typeof raw === "object") {
    const obj = raw as Record<string, unknown>;
    // Try common property names the API might use
    for (const key of ["state", "status", "type"]) {
      if (typeof obj[key] === "string") return obj[key] as string;
    }
    // Last resort: check for a meaningful boolean flag
    if (obj.running === true) return "running";
    if (obj.done === true) return "completed";
    if (obj.error === true) return "error";
  }
  return "unknown";
}

// ── Structured Error Surfacing (MEK-282) ──────────────────────────────

export type StructuredErrorCode =
  | "EMPTY_RESPONSE"
  | "PROVIDER_ERROR"
  | "TIMEOUT"
  | "SESSION_HANG"
  | "AUTH_FAILED"
  | "RATE_LIMITED"
  | "INVALID_DIRECTORY"
  | "SHELL_CONTENT_REFUSED"
  | "UNKNOWN";

/**
 * Typed error thrown by `opencode_shell_execute` (and future similar tools)
 * when the wrapper refuses a command for content-discipline reasons —
 * currently: unescaped backticks (issue #25, file-first content discipline).
 *
 * The refusal is **deterministic** (the wrapper rejects before any LLM call),
 * so downstream skills like `opencode-fallback-chain` should NOT retry on a
 * different provider — retrying yields the same refusal.
 *
 * Carries `SHELL_CONTENT_REFUSED` through `buildStructuredError()` via an
 * `instanceof` check that runs before any HTTP-status / message-pattern
 * classification.  Issue #28.
 */
export class ShellContentRefusedError extends Error {
  readonly code = "SHELL_CONTENT_REFUSED" as const;
  constructor(message: string) {
    super(message);
    this.name = "ShellContentRefusedError";
  }
}

/**
 * Typed error thrown by `opencode_run` / `opencode_run_streaming` /
 * `opencode_ask` / `opencode_reply` / `opencode_message_send` when the
 * assistant message that terminates the session contains no text content
 * (parts array empty, all text parts blank, or response object missing
 * entirely).  Detected via `analyzeMessageResponse()` (`isEmpty === true`).
 *
 * Issue #26 — before this typed error existed, the wrapper would treat
 * "session reached idle" as success regardless of whether the assistant
 * produced any output.  Out-of-roster OpenRouter dispatches (see
 * `opencode-agent`'s `OPENROUTER-MODELS.md`) silently returned `(no response
 * text)` with no error surfaced and no fallback chain triggered.
 *
 * Carries `EMPTY_RESPONSE` through `buildStructuredError()` via an
 * `instanceof` check.  This is a stable surface for the
 * `opencode-fallback-chain` skill, which already maps `EMPTY_RESPONSE` to
 * "trigger fallback (degenerate model output)" — see opencode-agent v1.1.0
 * CHANGELOG entry.
 */
export class EmptyResponseError extends Error {
  readonly code = "EMPTY_RESPONSE" as const;
  constructor(message: string) {
    super(message);
    this.name = "EmptyResponseError";
  }
}

export interface StructuredError {
  code: StructuredErrorCode;
  message: string;
  raw?: {
    httpStatus?: number;
    method?: string;
    path?: string;
    body?: string;
    bodyJson?: unknown;
    headers?: Record<string, string>;
  };
  provider?: string;
  modelIdRequested?: string;
  modelIdEffective?: string;
  tokenUsage?: { prompt?: number; completion?: number; reasoning?: number };
  sessionId?: string;
  suggestedAction?: string;
}

export interface ErrorContext {
  providerID?: string;
  modelID?: string;
  sessionId?: string;
  responseParts?: unknown[];
}

function getSuggestedAction(code: StructuredErrorCode, message?: string): string | undefined {
  switch (code) {
    case "AUTH_FAILED":
      return "Check credentials with opencode_provider_test, set key with opencode_auth_set";
    case "RATE_LIMITED":
      return "Wait and retry, or switch provider/model";
    case "TIMEOUT":
      return "Use opencode_run for complex tasks (handles polling automatically)";
    case "PROVIDER_ERROR":
      return "The provider returned an error. Check the body field for details.";
    case "EMPTY_RESPONSE":
      return "Provider returned no text. Check API key, model availability, or quota.";
    case "INVALID_DIRECTORY":
      return "Pass an absolute path to an existing directory.";
    case "SESSION_HANG":
      return "Try opencode_session_abort then retry.";
    case "SHELL_CONTENT_REFUSED":
      return "Wrapper-level discipline refusal — do NOT retry on a different provider, the outcome is deterministic. Rewrite the command using the file-first pattern: write the content to a file via your client's Write tool, then reference it with --body-file / --notes-file / -F body=@file / < file. See https://github.com/MekaretEriker/opencode-mcp/issues/25.";
    default:
      return diagnoseUnknownSuggestion(message);
  }
}

function diagnoseUnknownSuggestion(msg: string | undefined): string | undefined {
  if (!msg) return undefined;
  const lower = msg.toLowerCase();
  if (lower.includes("econnrefused")) {
    return "The OpenCode server is not accepting connections. Is `opencode serve` running? Check with `opencode_setup`. Verify OPENCODE_BASE_URL is correct (default: http://127.0.0.1:4096). The server will auto-reconnect on the next request if OPENCODE_AUTO_SERVE is enabled.";
  }
  if (lower.includes("enotfound") || lower.includes("ehostunreach")) {
    return "Cannot reach the OpenCode server host. Check that OPENCODE_BASE_URL points to a reachable address. If running remotely, verify network connectivity.";
  }
  if (lower.includes("etimedout")) {
    return "The server is not responding (connection timed out). The server may be overloaded or starting up — retry in a few seconds. Check with `opencode_setup` to verify server health.";
  }
  if (lower.includes("unreachable") || lower.includes("fetch failed")) {
    return "Is `opencode serve` running? Check with `opencode_setup`. Verify OPENCODE_BASE_URL is correct (default: http://127.0.0.1:4096).";
  }
  if (lower.includes("session") && lower.includes("not found")) {
    return "List active sessions with `opencode_sessions_overview`.";
  }
  return undefined;
}

export function buildStructuredError(e: unknown, ctx?: ErrorContext): StructuredError {
  const message = e instanceof Error ? e.message : String(e);
  const lower = message.toLowerCase();
  let code: StructuredErrorCode;

  // Typed-error fast paths (checked before HTTP-status / message-pattern
  // classification per AGENTS.md — "Add a classification branch BEFORE the
  // generic TIMEOUT branch", here promoted to first position because typed
  // errors are unambiguous).  Issues #28, #26.
  if (e instanceof ShellContentRefusedError) {
    code = "SHELL_CONTENT_REFUSED";
  } else if (e instanceof EmptyResponseError) {
    code = "EMPTY_RESPONSE";
  } else if (e instanceof OpenCodeError) {
    if (e.status === 401 || e.status === 403) code = "AUTH_FAILED";
    else if (e.status === 429) code = "RATE_LIMITED";
    else if (e.status >= 500) code = "PROVIDER_ERROR";
    else code = "PROVIDER_ERROR";
  } else if (lower.includes("did not emit session.idle") || lower.includes("session.idle within")) {
    code = "SESSION_HANG";
  } else if (
    lower.includes("timeout") ||
    lower.includes("timed out") ||
    lower.includes("aborted") ||
    lower.includes("etimedout")
  ) {
    code = "TIMEOUT";
  } else if (lower.includes("no text content") || lower.includes("empty response")) {
    code = "EMPTY_RESPONSE";
  } else if (lower.includes("directory not found") || lower.includes("not an absolute path")) {
    code = "INVALID_DIRECTORY";
  } else if (
    lower.includes("401") ||
    lower.includes("403") ||
    lower.includes("api key") ||
    lower.includes("unauthorized") ||
    lower.includes("forbidden")
  ) {
    code = "AUTH_FAILED";
  } else if (lower.includes("rate limit") || lower.includes("429")) {
    code = "RATE_LIMITED";
  } else {
    code = "UNKNOWN";
  }

  const result: StructuredError = { code, message };

  if (e instanceof OpenCodeError) {
    const raw: StructuredError["raw"] = {
      httpStatus: e.status,
      method: e.method,
      path: e.path,
      body: e.body,
    };
    try {
      raw.bodyJson = JSON.parse(e.body);
    } catch { /* not JSON — leave bodyJson undefined */ }
    result.raw = raw;
  }

  if (ctx) {
    if (ctx.providerID) result.provider = ctx.providerID;
    if (ctx.modelID) result.modelIdRequested = ctx.modelID;
    if (ctx.sessionId) result.sessionId = ctx.sessionId;
    if (ctx.responseParts) {
      const stepFinish = (ctx.responseParts as any[]).find(
        (p: any) => p.type === "step-finish" && p.tokens,
      );
      if (stepFinish?.tokens) {
        result.tokenUsage = {
          prompt: stepFinish.tokens.input,
          completion: stepFinish.tokens.output,
          reasoning: stepFinish.tokens.reasoning,
        };
      }
    }
  }

  result.suggestedAction = getSuggestedAction(code, message);

  return result;
}

export function formatErrorHuman(structured: StructuredError): string {
  let text = `Error [${structured.code}]: ${structured.message}`;
  if (structured.raw?.httpStatus) {
    text += ` (HTTP ${structured.raw.httpStatus})`;
  }
  if (structured.suggestedAction) {
    text += `\n\n**Suggestion:** ${structured.suggestedAction}`;
  }
  return text;
}

/**
 * Standard tool response builder.
 */
export function toolResult(text: string, isError = false) {
  return {
    content: [{ type: "text" as const, text }],
    ...(isError ? { isError: true } : {}),
  };
}

export function toolError(e: unknown, ctx?: ErrorContext) {
  const structured = buildStructuredError(e, ctx);
  const safeStructured = redactSecrets(structured) as StructuredError;
  const human = formatErrorHuman(structured);
  const text = `${human}\n\n<!-- structured-error\n${JSON.stringify(safeStructured, null, 2)}\n-->`;
  return toolResult(text, true);
}

export function toolJson(value: unknown) {
  return toolResult(safeStringify(value));
}
