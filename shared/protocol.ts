/** 서버 <-> 클라이언트 공용 프로토콜 타입 */

export type UIContentBlock =
  | { type: "text"; text: string }
  | { type: "thinking"; text: string }
  | {
      type: "toolCall";
      id: string;
      name: string;
      args: unknown;
      /** 페어링된 tool result (있으면) */
      result?: {
        text: string;
        isError: boolean;
        /** edit 등 일부 도구가 돌려주는 실제 diff (details.diff) */
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

/** 세션 컨텍스트 사용량 (SDK getContextUsage) */
export interface UIContextUsage {
  /** 컨텍스트에 있는 토큰 수 (컴팩션 직후 등 알 수 없으면 null) */
  tokens: number | null;
  contextWindow: number;
  percent: number | null;
}

export interface UISnapshot {
  messages: UIMessage[];
  isStreaming: boolean;
  model: UIModel | null;
  thinkingLevel: UIThinkingLevel;
  /** 현재 모델이 지원하는 thinking level 목록 */
  thinkingLevels: UIThinkingLevel[];
  sessionFile?: string;
  /** URL(/s/:id)에 쓰는 세션 식별자 */
  sessionId?: string;
  /** 컨텍스트 사용량 (미지원 모델이면 null) */
  context?: UIContextUsage | null;
}

export interface UISessionInfo {
  /** URL(/s/:id)에 쓰는 세션 식별자 */
  id: string;
  path: string;
  /** 세션이 속한 프로젝트 디렉토리 (표시용, ~ 축약) */
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
  /** 표시용 이름 (파일명 또는 패키지 내 경로) */
  name: string;
  /** 패키지 확장이면 패키지명 (예: "pi-subagents") */
  packageName?: string;
  /** 홈디렉토리를 ~ 로 축약한 경로 */
  path: string;
  scope: "user" | "project" | "temporary";
  /** 등록된 커스텀 툴 이름 */
  tools: string[];
  /** 등록된 슬래시 커맨드 */
  commands: string[];
  /** 등록된 플래그 */
  flags: string[];
  /** 핸들러가 등록된 이벤트 이름 */
  events: string[];
}

export interface UIExtensionsResponse {
  extensions: UIExtensionInfo[];
  /** 로드에 실패한 확장 */
  errors: { path: string; error: string }[];
}

/** ~/.pi/agent/models.json 의 커스텀 모델 (편집 가능한 필드만 노출) */
export interface UICustomModel {
  id: string;
  name?: string;
  reasoning?: boolean;
  contextWindow?: number;
  maxTokens?: number;
  /** 입력 모달리티 (기본 ["text"]) */
  input?: ("text" | "image")[];
}

export type UICustomApi =
  | "openai-completions"
  | "openai-responses"
  | "anthropic-messages"
  | "google-generative-ai";

export interface UICustomProvider {
  /** models.json 의 providers 키 (예: "ollama") */
  key: string;
  baseUrl: string;
  api: UICustomApi;
  /** 값 또는 "$ENV_VAR" 형식 */
  apiKey?: string;
  models: UICustomModel[];
}

export interface UICustomModelsResponse {
  /** ~ 로 축약한 models.json 경로 */
  path: string;
  providers: UICustomProvider[];
  /** 파싱 실패 시 메시지 (이 경우 편집 저장은 위험하므로 UI에서 경고) */
  parseError?: string;
  /** 저장 후 재시작 없이 반영되지 않은 경우의 안내 */
  warning?: string;
}

export interface UIImageAttachment {
  /** base64 (data URL 아님) */
  data: string;
  mimeType: string;
}

export type ServerEvent =
  | { type: "snapshot"; snapshot: UISnapshot }
  | {
      type: "hello";
      /** 서버 빌드 버전 — 클라이언트 __APP_VERSION__ 과 다르면 새로고침 유도 */
      version: string;
    }
  /**
   * 이 연결이 URL에 공개된 세션.
   * 기존 /s/:id 접속 시 즉시, `/` 초안은 첫 prompt 때 전송 → 클라이언트는 /s/:id 로 교체.
   * 포크 등으로 id가 바뀌면 다시 전송.
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
