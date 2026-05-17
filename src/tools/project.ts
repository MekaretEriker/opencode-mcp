/**
 * Project tools — list all projects, get current active project.
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
 * Both tools mapped to typed SDK methods — no gaps:
 * - `sdk.project.list()`    → GET /project
 * - `sdk.project.current()` → GET /project/current
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { OpenCodeClient } from "../client.js";
import type { OpencodeClient } from "@opencode-ai/sdk/client";
import { toolJson, toolError, toolResult, directoryParam } from "../helpers.js";

/** Format a project object into a compact summary. */
function formatProject(p: Record<string, unknown>): string {
  const worktree = (p.worktree ?? "unknown") as string;
  const name = (worktree !== "unknown" ? worktree.split("/").filter(Boolean).pop() : undefined)
    ?? p.name ?? p.id ?? "unknown";
  const lines: string[] = [];
  lines.push(`Name: ${name}`);
  lines.push(`Path: ${worktree}`);
  if (p.vcs) lines.push(`VCS: ${p.vcs}`);
  if (p.id) lines.push(`ID: ${p.id}`);
  const time = p.time as Record<string, unknown> | undefined;
  if (time?.created) {
    lines.push(`Created: ${new Date(time.created as number).toISOString()}`);
  }
  if (time?.updated) {
    lines.push(`Updated: ${new Date(time.updated as number).toISOString()}`);
  }
  return lines.join("\n");
}

export function registerProjectTools(
  server: McpServer,
  client: OpenCodeClient,
  sdkFactory?: (directory?: string) => OpencodeClient,
) {
  server.tool(
    "opencode_project_list",
    "List all projects known to the opencode server",
    {
      directory: directoryParam,
    },
    async ({ directory }) => {
      const sdk = sdkFactory?.(directory);
      try {
        const raw = sdk
          ? (await sdk.project.list()).data
          : await client.get("/project", undefined, directory);
        const projects = Array.isArray(raw) ? raw as Array<Record<string, unknown>> : [];
        if (projects.length === 0) {
          return toolResult("No projects found.");
        }
        const lines = projects.map((p) => {
          const worktree = (p.worktree ?? "?") as string;
          const name = (worktree !== "?" ? worktree.split("/").filter(Boolean).pop() : undefined)
            ?? p.name ?? p.id ?? "(root)";
          const vcs = p.vcs ? ` [${p.vcs}]` : "";
          return `- ${name}: ${worktree}${vcs}`;
        });
        return toolResult(`## Projects (${projects.length})\n${lines.join("\n")}`);
      } catch (e) {
        return toolError(e);
      }
    },
  );

  server.tool(
    "opencode_project_current",
    "Get the current active project",
    {
      directory: directoryParam,
    },
    async ({ directory }) => {
      const sdk = sdkFactory?.(directory);
      try {
        const raw = sdk
          ? (await sdk.project.current()).data
          : await client.get("/project/current", undefined, directory);
        const p = raw as Record<string, unknown>;
        if (p && typeof p === "object") {
          return toolResult(formatProject(p));
        }
        return toolJson(raw);
      } catch (e) {
        return toolError(e);
      }
    },
  );
}
