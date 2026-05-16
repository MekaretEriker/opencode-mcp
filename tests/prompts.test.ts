import { describe, it, expect, vi } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerPrompts } from "../src/prompts.js";

function capturePrompts() {
  const prompts = new Map<
    string,
    { description: string; handler: Function }
  >();
  const mockServer = {
    prompt: vi.fn(
      (name: string, description: string, _schema: unknown, handler: Function) => {
        prompts.set(name, { description, handler });
      },
    ),
  } as unknown as McpServer;
  registerPrompts(mockServer);
  return { prompts, server: mockServer };
}

describe("Prompt registration", () => {
  it("registers all 6 prompts", () => {
    const { prompts } = capturePrompts();
    expect(prompts.size).toBe(6);
  });

  it("registers expected prompt names", () => {
    const { prompts } = capturePrompts();
    const expected = [
      "opencode-code-review",
      "opencode-debug",
      "opencode-project-setup",
      "opencode-implement",
      "opencode-best-practices",
      "opencode-session-summary",
    ];
    for (const name of expected) {
      expect(prompts.has(name), `Missing prompt: ${name}`).toBe(true);
    }
  });
});

describe("Prompt handlers", () => {
  it("code-review prompt includes sessionId", async () => {
    const { prompts } = capturePrompts();
    const handler = prompts.get("opencode-code-review")!.handler;
    const result = await handler({ sessionId: "sess-123" });
    expect(result.messages).toHaveLength(1);
    expect(result.messages[0].role).toBe("user");
    expect(result.messages[0].content.text).toContain("sess-123");
    expect(result.messages[0].content.text).toContain("review");
  });

  it("debug prompt includes issue and optional context", async () => {
    const { prompts } = capturePrompts();
    const handler = prompts.get("opencode-debug")!.handler;

    // With context
    const result1 = await handler({
      issue: "App crashes on startup",
      context: "see error.log",
    });
    expect(result1.messages[0].content.text).toContain("App crashes on startup");
    expect(result1.messages[0].content.text).toContain("see error.log");

    // Without context
    const result2 = await handler({ issue: "Slow query" });
    expect(result2.messages[0].content.text).toContain("Slow query");
  });

  it("project-setup prompt takes no arguments", async () => {
    const { prompts } = capturePrompts();
    const handler = prompts.get("opencode-project-setup")!.handler;
    const result = await handler({});
    expect(result.messages).toHaveLength(1);
    expect(result.messages[0].content.text).toContain("project");
  });

  it("implement prompt includes description and optional requirements", async () => {
    const { prompts } = capturePrompts();
    const handler = prompts.get("opencode-implement")!.handler;

    const result = await handler({
      description: "Add dark mode",
      requirements: "Must support system preference",
    });
    expect(result.messages[0].content.text).toContain("Add dark mode");
    expect(result.messages[0].content.text).toContain("Must support system preference");
  });

  it("best-practices prompt returns comprehensive guide", async () => {
    const { prompts } = capturePrompts();
    const handler = prompts.get("opencode-best-practices")!.handler;
    const result = await handler({});
    expect(result.messages).toHaveLength(1);
    expect(result.messages[0].role).toBe("user");
    const text = result.messages[0].content.text;
    expect(text).toContain("Best Practices");
    expect(text).toContain("opencode_setup");
    expect(text).toContain("providerID");
    expect(text).toContain("Common Pitfalls");
  });

  it("session-summary prompt includes sessionId", async () => {
    const { prompts } = capturePrompts();
    const handler = prompts.get("opencode-session-summary")!.handler;
    const result = await handler({ sessionId: "sess-456" });
    expect(result.messages[0].content.text).toContain("sess-456");
  });
});
