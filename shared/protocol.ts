/** Shared server <-> client protocol types */

/** Todo 工具의 작업 하나 (toolResult details.tasks 의 부분 집합) */
export interface UITodoTask {
  id: number;
  subject: string;
  status: string;
  activeForm?: string;
}

/** The task currently being worked on, summarized for the composer status row. */
export interface UIActiveTodo {
  subject: string;
  activeForm?: string;
  /** Current task state; completed is emitted for a fully completed todo list. */
  status: "in_progress" | "completed";
  /** One-based position of the active task in the todo list. */
  current: number;
  total: number;
}

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
        /** Full task list snapshot from the todo tool (details.tasks) */
        tasks?: UITodoTask[];
      };
    }
  | { type: "image"; dataUrl?: string };

export interface UIMessage {
  role: "user" | "assistant" | "custom";
  content: UIContentBlock[];
  errorMessage?: string;
  /** Message creation time in Unix milliseconds. */
  timestamp?: number;
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
  /** Current todo task, when the latest todo snapshot has an active item. */
  activeTodo?: UIActiveTodo;
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
  /** Whether a loaded runtime for this session is streaming (running dot in sidebar) */
  isStreaming?: boolean;
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

/** A slash command available in the current session. */
export interface UICommandInfo {
  /** Invokable name without the leading slash. */
  name: string;
  description?: string;
  /** Commands are grouped by where pi loaded them from. */
  source: "builtin" | "extension" | "prompt" | "skill";
  /** Resource scope for non-built-in commands. */
  scope?: "user" | "project" | "temporary";
  /** Short hint shown after completing a command with arguments. */
  argumentHint?: string;
}

export type UIClientAction =
  | { action: "open_settings" }
  | { action: "open_model" }
  | { action: "open_fork" }
  | { action: "open_sessions" }
  | { action: "new_session" }
  | { action: "copy_text"; text: string };

export type UIExtensionUIRequest =
  | { id: string; method: "select"; title: string; options: string[] }
  | { id: string; method: "confirm"; title: string; message: string }
  | { id: string; method: "input"; title: string; placeholder?: string }
  | { id: string; method: "editor"; title: string; prefill?: string };

export interface UIExtensionUIResponse {
  id: string;
  cancelled?: boolean;
  value?: string;
  confirmed?: boolean;
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
  /** Provider-native names for the supported thinking strengths. */
  thinkingLevelMap?: Partial<Record<UIThinkingLevel, string | null>>;
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

/** The provider connection details used to discover remote model ids. */
export type UIModelDiscoveryRequest = Pick<UICustomProvider, "baseUrl" | "api" | "apiKey">;

export interface UIModelDiscoveryResponse {
  models: string[];
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
      /** User-facing descriptions for the server build version. */
      updateNotes?: string[];
    }
  /**
   * Session this connection is bound to in the URL.
   * Sent immediately on an existing /s/:id connect; for a `/` draft it is sent
   * on the first prompt → the client switches to /s/:id. Re-sent when the id
   * changes (e.g. fork).
   */
  | { type: "session_bound"; sessionId: string }
  | { type: "delta"; kind: "text" | "thinking"; delta: string }
  /** The agent closed its current reasoning block; keep it available but collapse it. */
  | { type: "thinking_end" }
  | { type: "tool_start"; toolCallId: string; toolName: string }
  | { type: "tool_end"; toolCallId: string; toolName: string; isError: boolean }
  | { type: "agent_start" }
  | { type: "agent_end" }
  | { type: "forked"; selectedText?: string }
  | { type: "command_catalog"; commands: UICommandInfo[] }
  | { type: "command_result"; message: string }
  | { type: "client_action"; action: UIClientAction }
  | { type: "extension_ui_request"; request: UIExtensionUIRequest }
  | { type: "error"; message: string };

export type ClientCommand =
  | { type: "prompt"; text: string; images?: UIImageAttachment[] }
  | { type: "abort" }
  | { type: "set_model"; provider: string; id: string }
  | { type: "set_thinking_level"; level: UIThinkingLevel }
  | { type: "fork"; entryId: string }
  | { type: "get_commands" }
  | { type: "extension_ui_response"; response: UIExtensionUIResponse };
