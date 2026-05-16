#!/usr/bin/env node

// Smoke test runner for opencode-mcp.
// Spawns the MCP server over stdio and calls tools to verify behavior.

import process from "node:process";
import { setTimeout as delay } from "node:timers/promises";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const REPO_DIR = process.cwd();
const DIRECTORY = process.env.OPENCODE_TEST_DIRECTORY ?? REPO_DIR;
const OPENCODE_BASE_URL = process.env.OPENCODE_BASE_URL ?? "http://127.0.0.1:4096";

function now() {
  return new Date().toISOString();
}

function shorten(s, n = 300) {
  if (typeof s !== "string") return String(s);
  if (s.length <= n) return s;
  return s.slice(0, n) + "...";
}

function toolText(result) {
  const parts = result?.content;
  if (!Array.isArray(parts)) return "";
  return parts.map((p) => (p && typeof p.text === "string" ? p.text : "")).join("\n");
}

function extractMessageIdsFromListOutput(text) {
  if (!text) return [];
  const ids = [];
  const re = /--- Message\s+\d+\s+\[[^\]]+\]\s+\(([^)]+)\)\s+---/g;
  let m;
  while ((m = re.exec(text))) {
    if (m[1]) ids.push(m[1]);
  }
  return ids;
}

async function fetchJson(url) {
  const res = await fetch(url, { headers: { "content-type": "application/json" } });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`HTTP ${res.status} for ${url}: ${shorten(text, 500)}`);
  }
  return await res.json();
}

function isProviderConfigured(p) {
  const source = p?.source;
  if (source === "env" || source === "config" || source === "api") return true;
  if (source === "custom") {
    const opts = p?.options;
    if (opts && typeof opts.apiKey === "string" && opts.apiKey !== "") return true;
    if (p?.id === "anthropic" && opts && Object.keys(opts).some((k) => k !== "apiKey")) return true;
  }
  return false;
}

function extractFirstModelId(provider) {
  const rawModels = provider?.models;
  const modelList = Array.isArray(rawModels)
    ? rawModels
    : rawModels && typeof rawModels === "object"
      ? Object.values(rawModels)
      : [];
  for (const m of modelList) {
    const id = m?.id ?? m?.name;
    if (typeof id === "string" && id) return id;
  }
  return null;
}

async function pickTestModel() {
  const raw = await fetchJson(`${OPENCODE_BASE_URL}/provider`);
  const providers = Array.isArray(raw?.all) ? raw.all : Array.isArray(raw) ? raw : [];
  const configured = providers.filter(isProviderConfigured);
  for (const p of configured) {
    const providerId = p?.id;
    if (typeof providerId !== "string" || !providerId) continue;
    const modelId = extractFirstModelId(p);
    if (modelId) return { providerId, modelId };
  }
  return null;
}

async function main() {
  const results = [];
  const record = (name, status, detail = "") => {
    results.push({ name, status, detail });
  };

  const calledTools = new Set();
  const skippedTools = new Set();

  console.log(`[${now()}] Starting opencode-mcp smoke test`);
  console.log(`- Repo: ${REPO_DIR}`);
  console.log(`- Directory: ${DIRECTORY}`);
  console.log(`- OpenCode: ${OPENCODE_BASE_URL}`);

  // Pick a configured provider+model for message tests.
  let testModel = null;
  try {
    testModel = await pickTestModel();
  } catch (e) {
    record("preflight:pickTestModel", "FAIL", e instanceof Error ? e.message : String(e));
  }
  if (!testModel) {
    record(
      "preflight:pickTestModel",
      "SKIP",
      "No configured provider/model detected from /provider; message-based tools may return empty responses.",
    );
  } else {
    record("preflight:pickTestModel", "PASS", `${testModel.providerId}/${testModel.modelId}`);
  }

  const transport = new StdioClientTransport({
    command: "node",
    args: ["dist/index.js"],
    cwd: REPO_DIR,
    stderr: "pipe",
    env: {
      OPENCODE_BASE_URL,
      // Don't auto-start a server during smoke tests.
      OPENCODE_AUTO_SERVE: "false",
    },
  });

  const client = new Client({ name: "opencode-mcp-smoke", version: "0.0.0" });
  if (transport.stderr) {
    transport.stderr.on("data", (buf) => {
      const s = String(buf);
      // Keep stderr quiet unless it looks meaningful.
      if (s.includes("Fatal") || s.includes("Error") || s.includes("Warning")) {
        process.stderr.write(s);
      }
    });
  }

  try {
    await client.connect(transport);
  } catch (e) {
    console.error("Failed to connect to MCP server:", e);
    process.exit(1);
  }

  // List tools.
  let tools = [];
  try {
    const list = await client.listTools();
    tools = list.tools ?? [];
    record("tools/list", "PASS", `${tools.length} tools`);
  } catch (e) {
    record("tools/list", "FAIL", e instanceof Error ? e.message : String(e));
  }

  const toolNames = new Set(tools.map((t) => t.name));
  const expected = [
    "opencode_setup",
    "opencode_ask",
    "opencode_reply",
    "opencode_provider_test",
    "opencode_status",
    "opencode_session_search",
  ];
  for (const name of expected) {
    record(
      `presence:${name}`,
      toolNames.has(name) ? "PASS" : "FAIL",
      toolNames.has(name) ? "" : "Missing tool",
    );
  }

  // Helper to call tool and validate it returns text.
  async function call(name, args, opts = {}) {
    const { allowError = false, validateText = true } = opts;
    const started = Date.now();
    try {
      console.log(`- call ${name}`);
      calledTools.add(name);
      const res = await client.callTool({ name, arguments: args });
      const t = toolText(res);
      const ms = Date.now() - started;
      if (!allowError && res?.isError) {
        record(name, "FAIL", `isError=true in ${ms}ms: ${shorten(t, 600)}`);
        return { ok: false, res, text: t };
      }
      if (validateText && (!t || t.trim() === "")) {
        record(name, "FAIL", `Empty text in ${ms}ms`);
        return { ok: false, res, text: t };
      }
      record(name, "PASS", `${ms}ms`);
      return { ok: true, res, text: t };
    } catch (e) {
      const ms = Date.now() - started;
      record(name, "FAIL", `Exception in ${ms}ms: ${e instanceof Error ? e.message : String(e)}`);
      return { ok: false, res: null, text: "" };
    }
  }

  // --- Core health + context ---
  await call("opencode_health", { directory: DIRECTORY });
  await call("opencode_status", { directory: DIRECTORY }, { allowError: true });
  await call("opencode_setup", { directory: DIRECTORY }, { allowError: true });
  await call("opencode_context", { directory: DIRECTORY }, { allowError: true });
  await call("opencode_path_get", { directory: DIRECTORY }, { allowError: true });
  await call("opencode_vcs_info", { directory: DIRECTORY }, { allowError: true });
  await call("opencode_project_current", { directory: DIRECTORY }, { allowError: true });
  await call("opencode_project_list", { directory: DIRECTORY }, { allowError: true });
  await call("opencode_config_get", { directory: DIRECTORY }, { allowError: true });
  await call("opencode_config_providers", { directory: DIRECTORY }, { allowError: true });

  // --- Providers ---
  await call("opencode_provider_list", { directory: DIRECTORY }, { allowError: true });
  await call("opencode_provider_auth_methods", { directory: DIRECTORY }, { allowError: true });
  if (testModel) {
    await call(
      "opencode_provider_models",
      { providerId: testModel.providerId, directory: DIRECTORY, limit: 5 },
      { allowError: true },
    );
  } else {
    record("opencode_provider_models", "SKIP", "No test model available");
  }

  // --- Sessions + messages (use a temp session) ---
  let sessionId = null;
  try {
    const created = await call(
      "opencode_session_create",
      { title: "[mcp-smoke] tools", directory: DIRECTORY },
      { allowError: true },
    );
    const text = created.text;
    // Try to extract ID from formatted output
    const m = text.match(/\bID:\s*([A-Za-z0-9_-]+)\b/);
    sessionId = m ? m[1] : null;
    if (!sessionId) {
      // fallback: list sessions and pick the most recent by title
      const list = await call("opencode_session_list", { directory: DIRECTORY }, { allowError: true });
      const lt = list.text;
      const m2 = lt.match(/\[([A-Za-z0-9_-]+)\]/);
      if (m2) sessionId = m2[1];
    }
    if (sessionId) {
      record("session:temp", "PASS", sessionId);
    } else {
      record("session:temp", "FAIL", `Could not extract session ID from: ${shorten(text, 300)}`);
    }
  } catch (e) {
    record("session:temp", "FAIL", e instanceof Error ? e.message : String(e));
  }

  if (sessionId) {
    await call("opencode_session_list", { directory: DIRECTORY }, { allowError: true });
    await call("opencode_session_get", { id: sessionId, directory: DIRECTORY }, { allowError: true });
    await call("opencode_session_update", { id: sessionId, title: "[mcp-smoke] tools updated", directory: DIRECTORY }, { allowError: true });
    await call("opencode_session_children", { id: sessionId, directory: DIRECTORY }, { allowError: true });
    await call("opencode_session_status", { directory: DIRECTORY }, { allowError: true });
    await call("opencode_session_todo", { id: sessionId, directory: DIRECTORY }, { allowError: true });
    await call("opencode_session_diff", { id: sessionId, directory: DIRECTORY }, { allowError: true });
    await call("opencode_review_changes", { sessionId, directory: DIRECTORY }, { allowError: true });
    await call("opencode_sessions_overview", { directory: DIRECTORY }, { allowError: true });
    await call("opencode_session_search", { query: "mcp-smoke", directory: DIRECTORY }, { allowError: true });

    // Permission tool is hard to test end-to-end without a real permission request.
    // Still verify it responds (likely error) and doesn't crash.
    await call(
      "opencode_session_permission",
      { id: sessionId, permissionID: "perm-does-not-exist", response: "accept", directory: DIRECTORY },
      { allowError: true },
    );

    // Fork + abort (best-effort)
    await call("opencode_session_fork", { id: sessionId, directory: DIRECTORY }, { allowError: true });
    await call("opencode_session_abort", { id: sessionId, directory: DIRECTORY }, { allowError: true });

    // Share/unshare (best-effort)
    await call("opencode_session_share", { id: sessionId, directory: DIRECTORY }, { allowError: true });
    await call("opencode_session_unshare", { id: sessionId, directory: DIRECTORY }, { allowError: true });

    // Message list + conversation
    const msgList = await call(
      "opencode_message_list",
      { sessionId, directory: DIRECTORY, limit: 10 },
      { allowError: true },
    );
    await call("opencode_conversation", { sessionId, directory: DIRECTORY, limit: 10 }, { allowError: true });

    if (testModel) {
      // message_send
      await call(
        "opencode_message_send",
        {
          sessionId,
          text: "Return the number 7.",
          providerID: testModel.providerId,
          modelID: testModel.modelId,
          directory: DIRECTORY,
        },
        { allowError: true },
      );

      // Refresh message list so we can test message_get + revert/unrevert
      const msgList2 = await call(
        "opencode_message_list",
        { sessionId, directory: DIRECTORY, limit: 10 },
        { allowError: true },
      );
      const ids = extractMessageIdsFromListOutput(msgList2.text);
      const lastId = ids.length > 0 ? ids[ids.length - 1] : null;
      if (lastId) {
        await call("opencode_message_get", { sessionId, messageId: lastId, directory: DIRECTORY }, { allowError: true });
        await call("opencode_session_revert", { id: sessionId, messageID: lastId, directory: DIRECTORY }, { allowError: true });
        await call("opencode_session_unrevert", { id: sessionId, directory: DIRECTORY }, { allowError: true });
      } else {
        record("opencode_message_get", "SKIP", "Could not extract messageId from message_list output");
        record("opencode_session_revert", "SKIP", "Could not extract messageId from message_list output");
        record("opencode_session_unrevert", "SKIP", "No revert executed");
      }

      // message_send_async + wait
      await call(
        "opencode_message_send_async",
        {
          sessionId,
          text: "Reply with the word OK.",
          providerID: testModel.providerId,
          modelID: testModel.modelId,
          directory: DIRECTORY,
        },
        { allowError: true },
      );
      await delay(1000);
      await call("opencode_wait", { sessionId, timeoutSeconds: 30, pollIntervalMs: 1000, directory: DIRECTORY }, { allowError: true });

      // Ask/reply workflows
      await call(
        "opencode_ask",
        {
          prompt: "Reply with just the word PONG.",
          providerID: testModel.providerId,
          modelID: testModel.modelId,
          directory: DIRECTORY,
        },
        { allowError: true },
      );
      await call(
        "opencode_reply",
        {
          sessionId,
          prompt: "Reply with just the word DONE.",
          providerID: testModel.providerId,
          modelID: testModel.modelId,
          directory: DIRECTORY,
        },
        { allowError: true },
      );

      // Slash command (best-effort; depends on server)
      await call(
        "opencode_command_execute",
        { sessionId, command: "help", arguments: "", directory: DIRECTORY },
        { allowError: true },
      );
    } else {
      record("message tools", "SKIP", "No configured provider/model available for message tests");
    }

    // provider_test with explicit model (should pass if provider works)
    if (testModel) {
      await call(
        "opencode_provider_test",
        { providerId: testModel.providerId, modelID: testModel.modelId, directory: DIRECTORY },
        { allowError: true },
      );
      // provider_test without modelID: should still work ideally
      await call(
        "opencode_provider_test",
        { providerId: testModel.providerId, directory: DIRECTORY },
        { allowError: true },
      );
    }

    // Finally, delete temp session
    await call("opencode_session_delete", { id: sessionId, directory: DIRECTORY }, { allowError: true });
  }

  // --- File tools ---
  await call("opencode_file_list", { path: ".", directory: DIRECTORY }, { allowError: true });
  await call("opencode_file_status", { directory: DIRECTORY }, { allowError: true });
  await call("opencode_file_read", { path: "package.json", directory: DIRECTORY }, { allowError: true });
  await call("opencode_find_text", { pattern: "opencode", directory: DIRECTORY }, { allowError: true });
  await call("opencode_find_file", { query: "package.json", directory: DIRECTORY }, { allowError: true });
  await call("opencode_find_symbol", { query: "register", directory: DIRECTORY }, { allowError: true });

  // --- Misc / experimental ---
  await call("opencode_agent_list", { directory: DIRECTORY }, { allowError: true });
  await call("opencode_command_list", { directory: DIRECTORY }, { allowError: true });
  await call("opencode_lsp_status", { directory: DIRECTORY }, { allowError: true });
  await call("opencode_formatter_status", { directory: DIRECTORY }, { allowError: true });
  await call("opencode_mcp_status", { directory: DIRECTORY }, { allowError: true });
  await call("opencode_tool_ids", { directory: DIRECTORY }, { allowError: true });

  // tool_list needs provider+model; try using testModel.
  if (testModel) {
    await call(
      "opencode_tool_list",
      { provider: testModel.providerId, model: testModel.modelId, directory: DIRECTORY },
      { allowError: true },
    );
  } else {
    record("opencode_tool_list", "SKIP", "No test model available");
  }

  await call(
    "opencode_log",
    { service: "mcp-smoke", level: "info", message: "smoke test" , directory: DIRECTORY },
    { allowError: true },
  );

  await call(
    "opencode_events_poll",
    { durationMs: 1000, maxEvents: 5, directory: DIRECTORY },
    { allowError: true },
  );

  // Skip potentially destructive or environment-dependent tools by design.
  const skipped = [
    "opencode_config_update",
    "opencode_instance_dispose",
    "opencode_shell_execute",
    "opencode_provider_oauth_authorize",
    "opencode_provider_oauth_callback",
    "opencode_auth_set",
    "opencode_mcp_add",
    "opencode_session_init",
    "opencode_session_summarize",
    // TUI tools require a running TUI; skip to avoid side effects.
    "opencode_tui_append_prompt",
    "opencode_tui_submit_prompt",
    "opencode_tui_clear_prompt",
    "opencode_tui_execute_command",
    "opencode_tui_show_toast",
    "opencode_tui_open_help",
    "opencode_tui_open_sessions",
    "opencode_tui_open_models",
    "opencode_tui_open_themes",
  ];
  for (const name of skipped) {
    if (toolNames.has(name)) {
      skippedTools.add(name);
      record(`skipped:${name}`, "SKIP", "Intentionally skipped");
    }
  }

  // If there are tools we didn't call (and didn't intentionally skip), report them.
  const untested = [];
  for (const name of toolNames) {
    if (!calledTools.has(name) && !skippedTools.has(name)) {
      untested.push(name);
    }
  }
  if (untested.length > 0) {
    record(
      "tools:untested",
      "FAIL",
      `Untested tool(s): ${untested.sort().join(", ")}`,
    );
  }

  // Close.
  await client.close();

  // Print report.
  const counts = results.reduce(
    (acc, r) => {
      acc[r.status] = (acc[r.status] ?? 0) + 1;
      return acc;
    },
    {},
  );

  console.log("\nReport:");
  console.log(`- PASS: ${counts.PASS ?? 0}`);
  console.log(`- FAIL: ${counts.FAIL ?? 0}`);
  console.log(`- SKIP: ${counts.SKIP ?? 0}`);

  const failures = results.filter((r) => r.status === "FAIL");
  if (failures.length > 0) {
    console.log("\nFailures:");
    for (const f of failures) {
      console.log(`- ${f.name}: ${f.detail}`);
    }
    process.exitCode = 2;
  }
}

main().catch((e) => {
  console.error("Smoke test crashed:", e);
  process.exit(1);
});
