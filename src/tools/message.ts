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
 * All 6 tools mapped to typed SDK methods — no gaps:
 * - `sdk.session.messages()`    → GET  /session/{id}/message (list)
 * - `sdk.session.message()`     → GET  /session/{id}/message/{messageID} (single)
 * - `sdk.session.prompt()`      → POST /session/{id}/message (sync)
 * - `sdk.session.promptAsync()` → POST /session/{id}/prompt_async
 * - `sdk.session.command()`     → POST /session/{id}/command
 * - `sdk.session.shell()`       → POST /session/{id}/shell
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
        if (/(?<!\\)`/.test(command)) {
          throw new Error(
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
}
