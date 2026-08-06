/** Shared server <-> client protocol types */

export type UIContentBlock =
  | { type: "text"; text: string }
  | { type: "thinking"; text: string }
  | {
      type: "toolCall";
      id: string;
      name: string;
      args: unknown;
      /** Paired tool result (when present) */
      result?: {
        text: string;
        isError: boolean;
        /** Actual diff returned by some tools (e.g. edit, details.diff) */
        diff?: string;
      };
    }
  | { type: "image"; dataUrl?: string };

export interface UIMessage {
  role: "user" | "assistant" | "custom";
  content: UIContentBlock[];
  errorMessage?: string;
}

export interface UIModel {
  provider: string;
  id: string;
  name?: string;
  reasoning?: boolean;
}

export type UIThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

/** Session context usage (SDK getContextUsage) */
export interface UIContextUsage {
  /** Tokens in context (null when unknown, e.g. right after compaction) */
  tokens: number | null;
  contextWindow: number;
  percent: number | null;
}

export interface UISnapshot {
  messages: UIMessage[];
  isStreaming: boolean;
  model: UIModel | null;
  thinkingLevel: UIThinkingLevel;
  /** Thinking levels the current model supports */
  thinkingLevels: UIThinkingLevel[];
  sessionFile?: string;
  /** Session identifier used in URL (/s/:id) */
  sessionId?: string;
  /** Context usage (null for unsupported models) */
  context?: UIContextUsage | null;
  /** Session working directory (project display in the header) */
  cwd?: string;
  /** Current branch when the cwd is a git repo, otherwise null */
  gitBranch?: string | null;
}

export interface UISessionInfo {
  /** Session identifier used in URL (/s/:id) */
  id: string;
  path: string;
  /** Project directory the session belongs to (for display, ~-shortened) */
  project: string;
  name?: string;
  firstMessage: string;
  modified: string;
  messageCount: number;
}

export interface UIForkPoint {
  entryId: string;
  text: string;
}

export interface UIExtensionInfo {
  /** Display name (filename or in-package path) */
  name: string;
  /** Package name for package extensions (e.g. "pi-subagents") */
  packageName?: string;
  /** Home-relative path with ~ abbreviation */
  path: string;
  scope: "user" | "project" | "temporary";
  /** Registered custom tool names */
  tools: string[];
  /** Registered slash commands */
  commands: string[];
  /** Registered flags */
  flags: string[];
  /** Event names with registered handlers */
  events: string[];
}

export interface UIExtensionsResponse {
  extensions: UIExtensionInfo[];
  /** Extensions that failed to load */
  errors: { path: string; error: string }[];
}

/** Custom models from ~/.pi/agent/models.json (only editable fields are exposed) */
export interface UICustomModel {
  id: string;
  name?: string;
  reasoning?: boolean;
  contextWindow?: number;
  maxTokens?: number;
  /** Input modalities (default ["text"]) */
  input?: ("text" | "image")[];
}

export type UICustomApi =
  | "openai-completions"
  | "openai-responses"
  | "anthropic-messages"
  | "google-generative-ai";

export interface UICustomProvider {
  /** providers key in models.json (e.g. "ollama") */
  key: string;
  baseUrl: string;
  api: UICustomApi;
  /** A value or "$ENV_VAR" */
  apiKey?: string;
  models: UICustomModel[];
}

export interface UICustomModelsResponse {
  /** models.json path, ~-shortened */
  path: string;
  providers: UICustomProvider[];
  /** Message when parsing failed (saving is then risky, so the UI warns) */
  parseError?: string;
  /** Notice when the change is not reflected without a restart */
  warning?: string;
}

export interface UIImageAttachment {
  /** base64 (not a data URL) */
  data: string;
  mimeType: string;
}

export type ServerEvent =
  | { type: "snapshot"; snapshot: UISnapshot }
  | {
      type: "hello";
      /** Server build version — prompts a reload when different from the client __APP_VERSION__ */
      version: string;
    }
  /**
   * Session this connection is bound to in the URL.
   * Sent immediately on an existing /s/:id connect; for a `/` draft it is sent
   * on the first prompt → the client switches to /s/:id. Re-sent when the id
   * changes (e.g. fork).
   */
  | { type: "session_bound"; sessionId: string }
  | { type: "delta"; kind: "text" | "thinking"; delta: string }
  | { type: "tool_start"; toolCallId: string; toolName: string }
  | { type: "tool_end"; toolCallId: string; toolName: string; isError: boolean }
  | { type: "agent_start" }
  | { type: "agent_end" }
  | { type: "forked"; selectedText?: string }
  | { type: "error"; message: string };

export type ClientCommand =
  | { type: "prompt"; text: string; images?: UIImageAttachment[] }
  | { type: "abort" }
  | { type: "set_model"; provider: string; id: string }
  | { type: "set_thinking_level"; level: UIThinkingLevel }
  | { type: "fork"; entryId: string };
