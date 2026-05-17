/**
 * Re-exported types from @opencode-ai/sdk for convenience.
 *
 * These are the most-used types in the codebase.  Import them from here
 * instead of from the SDK directly so we have a single point to adapt
 * if the SDK's export shape ever changes.
 *
 * Phase B (MEK-296): foundation for the SDK migration.  Types are
 * auto-generated from the server's OpenAPI spec (opencode 1.14.50)
 * and version-locked with the SDK.
 *
 * @see https://opencode.ai/docs/sdk.md
 */

export type {
  Session,
  SessionStatus,
  Message,
  UserMessage,
  AssistantMessage,
  Part,
  TextPart,
  ToolPart,
  StepFinishPart,
  FilePart,
  FileDiff,
  Agent,
  AgentConfig,
  Config,
  Provider,
  ProviderConfig,
  Project,
  Event,
  EventSessionIdle,
  EventSessionStatus,
  EventMessageUpdated,
  EventTodoUpdated,
  Permission,
  Todo,
  Model,
  File,
  FileNode,
  Symbol,
} from "@opencode-ai/sdk";
