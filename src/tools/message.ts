/**
 * Message tools — send prompts, list history, execute commands/shell.
 *
 * Phase C (MEK-297 + MEK-289): migrated to use typed SDK methods via the
 * optional `sdkFactory` parameter.  Each handler calls
 * `sdkFactory?.(directory)` to obtain a per-directory SDK client, because
 * `createCoworkClient` bakes `directory` into the customFetch closure at
 * construction time (see sdk-adapter.ts:180+222).  A global cache in
 * `src/index.ts` ensures equivalent directories share a client instance.
 *
 * When `sdkFactory` is undefined (tests, legacy consumers), the handler
 * falls back to the legacy `OpenCodeClient.post/get` methods, which
 * propagate `directory` per-request via the `{directory}` option.
 *
 * Tools mapped to typed SDK methods — no gaps:
 * - `sdk.session.messages()`    → GET  /session/{id}/message (list)
 * - `sdk.session.message()`     → GET  /session/{id}/message/{messageID} (single)
 * - `sdk.session.prompt()`      → POST /session/{id}/message (sync)
 * - `sdk.session.promptAsync()` → POST /session/{id}/prompt_async
 * - `sdk.session.command()`     → POST /session/{id}/command
 * - `sdk.session.shell()`       → POST /session/{id}/shell  (used by both
 *   `opencode_shell_execute` and `opencode_write_file`)
 *
 * `opencode_write_file` (#39) is a content-discipline wrapper over
 * `session.shell`: it composes a base64-decode pipeline so that file
 * content never travels through the LLM stream (which deadlocks on
 * certain payloads via DeepSeek/OpenRouter, see issue #39).
 */

import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { OpenCodeClient } from "../client.js";
import type { OpencodeClient } from "@opencode-ai/sdk/client";
import {
  toolResult,
  toolError,
  formatMessageResponse,
  analyzeMessageResponse,
  formatMessageList,
  applyModelDefaults,
  directoryParam,
  ShellContentRefusedError,
  EmptyResponseError,
  composeWriteFileCommand,
} from "../helpers.js";

export function registerMessageTools(
  server: McpServer,
  client: OpenCodeClient,
  sdkFactory?: (directory?: string) => OpencodeClient,
) {
  server.tool(
    "opencode_message_list",
    "List all messages in a session with formatted output showing roles and content",
    {
      sessionId: z.string().describe("Session ID"),
      limit: z
        .number()
        .optional()
        .describe("Maximum number of messages to return"),
      directory: directoryParam,
    },
    async ({ sessionId, limit, directory }) => {
      const sdk = sdkFactory?.(directory);
      try {
        const query: Record<string, string> = {};
        if (limit !== undefined) query.limit = String(limit);
        const messages = sdk
          ? (await sdk.session.messages({ path: { id: sessionId }, query: Object.keys(query).length > 0 ? { limit: Number(query.limit) } : undefined })).data
          : await client.get(
              `/session/${sessionId}/message`,
              query,
              directory,
            );
        return toolResult(formatMessageList(messages as unknown[]));
      } catch (e) {
        return toolError(e);
      }
    },
  );

  server.tool(
    "opencode_message_get",
    "Get details of a specific message in a session",
    {
      sessionId: z.string().describe("Session ID"),
      messageId: z.string().describe("Message ID"),
      directory: directoryParam,
    },
    async ({ sessionId, messageId, directory }) => {
      const sdk = sdkFactory?.(directory);
      try {
        const msg = sdk
          ? (await sdk.session.message({ path: { id: sessionId, messageID: messageId } })).data
          : await client.get(
              `/session/${sessionId}/message/${messageId}`,
              undefined,
              directory,
            );
        return toolResult(formatMessageResponse(msg));
      } catch (e) {
        return toolError(e);
      }
    },
  );

  server.tool(
    "opencode_message_send",
    "Send a prompt message to a session and wait for the AI response. Use parts to send text, and optionally specify a model.",
    {
      sessionId: z.string().describe("Session ID"),
      text: z.string().describe("The text message to send"),
      providerID: z
        .string()
        .optional()
        .describe("Provider ID (e.g. 'anthropic')"),
      modelID: z
        .string()
        .optional()
        .describe("Model ID (e.g. 'claude-3-5-sonnet-20241022')"),
      variant: z.string().optional().describe("Model variant (e.g. 'fast', 'smart')"),
      agent: z.string().optional().describe("Agent to use"),
      noReply: z
        .boolean()
        .optional()
        .describe(
          "If true, inject context without triggering AI response (useful for plugins)",
        ),
      system: z.string().optional().describe("System prompt override"),
      directory: directoryParam,
    },
    async ({
      sessionId,
      text,
      providerID,
      modelID,
      variant,
      agent,
      noReply,
      system,
      directory,
    }) => {
      const sdk = sdkFactory?.(directory);
      try {
        const body: Record<string, unknown> = {
          parts: [{ type: "text", text }],
        };
        const model = applyModelDefaults(providerID, modelID, variant);
        if (model) body.model = model;
        if (agent) body.agent = agent;
        if (noReply !== undefined) body.noReply = noReply;
        if (system) body.system = system;
        const response = sdk
          ? (await sdk.session.prompt({ path: { id: sessionId }, body: body as any })).data
          : await client.post(
              `/session/${sessionId}/message`,
              body,
              { directory },
            );

        const analysis = analyzeMessageResponse(response);

        // Empty response → EMPTY_RESPONSE structured error (issue #26).
        if (analysis.isEmpty) {
          const respParts = (response as { parts?: unknown[] } | null | undefined)?.parts;
          const ctx: { providerID?: string; modelID?: string; sessionId?: string; responseParts?: unknown[] } = {
            providerID,
            modelID,
            sessionId,
          };
          if (Array.isArray(respParts)) ctx.responseParts = respParts;
          return toolError(new EmptyResponseError(analysis.warning ?? "The AI returned a response with no text content."), ctx);
        }

        const formatted = formatMessageResponse(response);
        const parts: string[] = [];
        if (formatted) parts.push(formatted);
        if (analysis.warning) {
          parts.push(`\n--- WARNING ---\n${analysis.warning}`);
        }
        return toolResult(
          parts.join("\n\n") || "Empty response.",
          analysis.hasError,
        );
      } catch (e) {
        return toolError(e, { providerID, modelID, sessionId });
      }
    },
  );

  server.tool(
    "opencode_message_send_async",
    "Send a prompt message asynchronously (fire-and-forget, does not wait for response). Use opencode_wait to poll for completion.",
    {
      sessionId: z.string().describe("Session ID"),
      text: z.string().describe("The text message to send"),
      providerID: z
        .string()
        .optional()
        .describe("Provider ID (e.g. 'anthropic')"),
      modelID: z
        .string()
        .optional()
        .describe("Model ID (e.g. 'claude-3-5-sonnet-20241022')"),
      variant: z.string().optional().describe("Model variant (e.g. 'fast', 'smart')"),
      agent: z.string().optional().describe("Agent to use"),
      directory: directoryParam,
    },
    async ({ sessionId, text, providerID, modelID, variant, agent, directory }) => {
      const sdk = sdkFactory?.(directory);
      try {
        const body: Record<string, unknown> = {
          parts: [{ type: "text", text }],
        };
        const model = applyModelDefaults(providerID, modelID, variant);
        if (model) body.model = model;
        if (agent) body.agent = agent;
        if (sdk) {
          await sdk.session.promptAsync({ path: { id: sessionId }, body: body as any });
        } else {
          await client.post(`/session/${sessionId}/prompt_async`, body, { directory });
        }
        return toolResult(
          "Message sent asynchronously. Use opencode_wait or opencode_message_list to check for responses.",
        );
      } catch (e) {
        return toolError(e, { providerID, modelID, sessionId });
      }
    },
  );

  server.tool(
    "opencode_command_execute",
    "Execute a slash command in a session (e.g. /init, /undo, /redo)",
    {
      sessionId: z.string().describe("Session ID"),
      command: z
        .string()
        .describe("The slash command to execute (e.g. 'init', 'undo')"),
      arguments: z
        .string()
        .optional()
        .describe("Arguments for the command"),
      agent: z.string().optional().describe("Agent to use"),
      providerID: z.string().optional().describe("Provider ID"),
      modelID: z.string().optional().describe("Model ID"),
      variant: z.string().optional().describe("Model variant"),
      directory: directoryParam,
    },
    async ({
      sessionId,
      command,
      arguments: args,
      agent,
      providerID,
      modelID,
      variant,
      directory,
    }) => {
      const sdk = sdkFactory?.(directory);
      try {
        const body: Record<string, unknown> = {
          command,
          arguments: args ?? "",
        };
        if (agent) body.agent = agent;
        const cmdModel = applyModelDefaults(providerID, modelID, variant);
        if (cmdModel) body.model = cmdModel;
        const result = sdk
          ? (await sdk.session.command({ path: { id: sessionId }, body: body as any })).data
          : await client.post(
              `/session/${sessionId}/command`,
              body,
              { directory },
            );
        return toolResult(formatMessageResponse(result));
      } catch (e) {
        return toolError(e, { providerID, modelID, sessionId });
      }
    },
  );

  server.tool(
    "opencode_shell_execute",
    [
      "Run a shell command through the opencode session.",
      "",
      "For commands embedding content (issue/PR bodies, release notes,",
      "commit messages, multiline text, anything with backticks, dollar-",
      "signs, single or double quotes, newlines, or heredocs): write the",
      "content to a file FIRST via your client's Write/file tool, then",
      "reference the file in this command with --body-file, --notes-file,",
      "-F body=@file, or input redirection (< file). Do NOT inline content",
      "with heredocs or quoted strings — the shell will eat backticks as",
      "command substitution and break quoting.",
      "",
      "Good:   gh issue create --body-file /tmp/body.md",
      "Bad:    gh issue create --body \"$(cat <<'EOF'...EOF)\"",
    ].join("\n"),
    {
      sessionId: z.string().describe("Session ID"),
      command: z.string().describe("Shell command to execute"),
      agent: z.string().describe("Agent to use for the shell command"),
      providerID: z.string().optional().describe("Provider ID"),
      modelID: z.string().optional().describe("Model ID"),
      variant: z.string().optional().describe("Model variant"),
      directory: directoryParam,
    },
    async ({ sessionId, command, agent, providerID, modelID, variant, directory }) => {
      const sdk = sdkFactory?.(directory);
      try {
        // #25 — file-first content discipline. Unescaped backticks trigger
        // command substitution and corrupt embedded content. Refuse and
        // teach the alternative.
        //
        // #28 — throw a typed ShellContentRefusedError so buildStructuredError
        // surfaces this as code: SHELL_CONTENT_REFUSED (not UNKNOWN), which
        // lets downstream skills like opencode-fallback-chain skip the retry
        // (the refusal is deterministic — no provider switch will help).
        if (/(?<!\\)`/.test(command)) {
          throw new ShellContentRefusedError(
            "Unescaped backtick in shell command. Backticks trigger command " +
            "substitution and corrupt embedded content. Write content to a " +
            "file via your client's Write tool, then reference it with " +
            "--body-file/--notes-file/-F body=@file/< file. See " +
            "https://github.com/MekaretEriker/opencode-mcp/issues/25"
          );
        }
        const body: Record<string, unknown> = { command, agent };
        const shellModel = applyModelDefaults(providerID, modelID, variant);
        if (shellModel) body.model = shellModel;
        const result = sdk
          ? (await sdk.session.shell({ path: { id: sessionId }, body: body as any })).data
          : await client.post(
              `/session/${sessionId}/shell`,
              body,
              { directory },
            );
        return toolResult(formatMessageResponse(result));
      } catch (e) {
        return toolError(e, { providerID, modelID, sessionId });
      }
    },
  );

  server.tool(
    "opencode_write_file",
    [
      "Materialize a file on the session host without routing the content",
      "through the LLM tool-call stream. Use this INSTEAD of asking the LLM",
      "to write a file via its native `write` tool when the content is",
      "prose / markdown >= 30 lines OR contains backticks, em-dashes,",
      "accented characters, or fenced code blocks — the native `write`",
      "tool stalls indefinitely on such payloads through certain providers",
      "(DeepSeek / OpenRouter confirmed). See issue #39.",
      "",
      "How it works: the wrapper encodes `content` as base64 in Node and",
      "composes `printf '%s' '<BASE64>' | base64 -d > <quoted-path>`, then",
      "dispatches via the same `session/shell` endpoint as",
      "opencode_shell_execute. Properties:",
      "  - Content never enters the LLM stream (cause of the stall in #39).",
      "  - Unicode preserved exactly (UTF-8 -> base64 -> UTF-8 round-trip).",
      "  - Generated command contains NO backticks - passes the",
      "    SHELL_CONTENT_REFUSED guard (#25/#28).",
      "  - Path is single-quoted with POSIX-safe escaping for embedded",
      "    quotes.",
      "",
      "After writing, you can reference the file in subsequent",
      "opencode_shell_execute calls (--body-file, --notes-file, < file).",
    ].join("\n"),
    {
      sessionId: z.string().describe("Session ID"),
      path: z
        .string()
        .describe(
          "Absolute path of the file to write on the session host (e.g. /tmp/body.md)",
        ),
      content: z
        .string()
        .describe(
          "Raw file content. Unicode supported. No size limit beyond MCP transport.",
        ),
      agent: z
        .string()
        .describe(
          "Agent to attribute the shell command to (same semantics as opencode_shell_execute)",
        ),
      providerID: z.string().optional().describe("Provider ID"),
      modelID: z.string().optional().describe("Model ID"),
      variant: z.string().optional().describe("Model variant"),
      directory: directoryParam,
    },
    async ({
      sessionId,
      path: filePath,
      content,
      agent,
      providerID,
      modelID,
      variant,
      directory,
    }) => {
      const sdk = sdkFactory?.(directory);
      try {
        // Compose the base64-decode pipeline (see composeWriteFileCommand
        // in helpers.ts).  Content never enters the LLM stream — that is
        // the whole point of this tool vs. delegating to the native
        // `write` tool (#39).
        const command = composeWriteFileCommand(filePath, content);

        const body: Record<string, unknown> = { command, agent };
        const shellModel = applyModelDefaults(providerID, modelID, variant);
        if (shellModel) body.model = shellModel;
        const result = sdk
          ? (await sdk.session.shell({ path: { id: sessionId }, body: body as any })).data
          : await client.post(
              `/session/${sessionId}/shell`,
              body,
              { directory },
            );
        return toolResult(formatMessageResponse(result));
      } catch (e) {
        return toolError(e, { providerID, modelID, sessionId });
      }
    },
  );
}
