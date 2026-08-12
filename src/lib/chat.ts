import { useSyncExternalStore } from "react";
import type {
  ClientCommand,
  ServerEvent,
  UIClientAction,
  UICommandInfo,
  UIExtensionUIRequest,
  UIExtensionUIResponse,
  UISnapshot,
} from "../../shared/protocol";
import { authHeaders, checkAuth } from "./auth";
import {
  clearComposerDraft,
  clearComposerDraftIfMatches,
  type SubmittedComposerPrompt,
} from "./composer-drafts";
import { notifyTaskComplete } from "./browserNotifications";
import { rememberSessionId } from "./resume";
import {
  SessionWorkspace,
  type WorkspaceClient,
  type WorkspaceTab,
} from "./session-workspace";

export interface ActiveTool {
  toolCallId: string;
  toolName: string;
}

/** WS lifecycle for chrome status (avoid red flash on first paint). */
export type ConnectionStatus = "connecting" | "connected" | "disconnected";
export type PromptStatus = "idle" | "waiting" | "responding" | "timeout" | "error";
export const PROMPT_RESPONSE_TIMEOUT_MS = 10_000;

export interface ChatState {
  connection: ConnectionStatus;
  /** Session id the server bound to this connection (for URL sync) */
  sessionId: string | null;
  snapshot: UISnapshot | null;
  /** Assistant text streaming right now (not yet in the snapshot) */
  streamText: string;
  streamThinking: string;
  /** The live thinking block has finished and should be collapsed immediately. */
  streamThinkingComplete: boolean;
  activeTools: ActiveTool[];
  /** Text to inject into the composer right after a fork (cleared after consumption) */
  injectText: string | null;
  /** Incremented to focus the composer textarea */
  focusToken: number;
  /** Server version differs from the client build → prompt a reload */
  updateAvailable: boolean;
  /** Version advertised by the server when an update is available. */
  updateVersion: string | null;
  /** User-facing descriptions for the advertised server version. */
  updateNotes: string[];
  /** Error event from the server (failed prompt etc.) — shown as a banner */
  lastError: string | null;
  /** Lifecycle of the most recently submitted prompt. */
  promptStatus: PromptStatus;
  /** Incremented when a pending prompt receives its first response. */
  promptResponseToken: number;
  /** Incremented when a pending prompt errors or times out before responding. */
  promptFailureToken: number;
  /** Low-priority confirmation from a slash command. */
  lastNotice: string | null;
  /** A slash command that opens an existing Web UI surface. */
  commandIntent: UIClientAction | null;
  /** Slash commands available in the connected session. */
  commands: UICommandInfo[];
  /** Current dialog requested by a pi extension. */
  extensionUIRequest: UIExtensionUIRequest | null;
}

function createInitialState(): ChatState {
  return {
    connection: "connecting",
    sessionId: null,
    snapshot: null,
    streamText: "",
    streamThinking: "",
    streamThinkingComplete: false,
    activeTools: [],
    injectText: null,
    focusToken: 0,
    updateAvailable: false,
    updateVersion: null,
    updateNotes: [],
    lastError: null,
    promptStatus: "idle",
    promptResponseToken: 0,
    promptFailureToken: 0,
    lastNotice: null,
    commandIntent: null,
    commands: [],
    extensionUIRequest: null,
  };
}

export class ChatClient implements WorkspaceClient<ChatState> {
  constructor(
    private readonly onSessionBound?: (sessionId: string) => void,
    private readonly promptResponseTimeoutMs = PROMPT_RESPONSE_TIMEOUT_MS,
    private readonly onPromptResponse?: (prompt: SubmittedComposerPrompt) => void,
    private readonly onDispose?: () => void,
  ) {}

  private ws: WebSocket | null = null;
  private listeners = new Set<() => void>();
  private reconnectDelay = 400;
  private intentionalClose = false;
  /** Advances for every socket opened explicitly or by a reconnect. */
  private connectionVersion = 0;
  /** A delayed reconnect must not outlive a session switch. */
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  /** After a drop, stay on "connecting" briefly before showing disconnected. */
  private disconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private everConnected = false;
  /** Session id to connect to (null = new session) */
  private target: string | null = null;
  /**
   * Working directory for a brand-new (draft) session. Remembered so a
   * reconnection after a drop keeps the draft in its original directory
   * instead of silently falling back to the default cwd.
   */
  private cwd: string | null = null;
  private promptTimeoutTimer: ReturnType<typeof setTimeout> | null = null;
  private promptAssistantCountAtSend = 0;
  private submittedPrompt: SubmittedComposerPrompt | null = null;
  /** Ignore late events until a timed-out run has fully aborted. */
  private promptRecoveryPending = false;
  private recoveryAgentEnded = false;
  private recoverySnapshotSettled = false;
  private recoveryAbortAcknowledged = false;
  /** Ignore one late agent_end from the run that timed out before a retry. */
  private ignoreLateRecoveryAgentEnd = false;

  /**
   * Stream deltas coalesced here and flushed on a fixed cadence. Fast models
   * emit ~100 delta frames/s; every flush re-renders the whole MessageList
   * and re-parses the accumulated markdown, so rendering per-token is a
   * sustained CPU load on phones (heat / battery drain). 100ms keeps the
   * stream visually smooth at ~10 updates/s.
   */
  private static readonly DELTA_FLUSH_MS = 100;
  private streamBuf: { text?: string; thinking?: string } | null = null;
  private flushTimer: ReturnType<typeof setTimeout> | null = null;

  private scheduleFlush() {
    if (this.flushTimer) return;
    // One-shot timeout: fires once, clears itself, and the next delta after
    // that schedules a fresh one. (setInterval here leaks — the callback
    // nulls the handle before it can be cleared, so a new interval gets
    // created every window and never stops.)
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      this.flushStreamBuffer();
    }, ChatClient.DELTA_FLUSH_MS);
  }

  /** Apply buffered deltas to state and stop the timer. */
  private flushStreamBuffer() {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    const buf = this.streamBuf;
    this.streamBuf = null;
    if (!buf) return;
    this.update({
      streamText: buf.text ? this.state.streamText + buf.text : this.state.streamText,
      streamThinking: buf.thinking
        ? this.state.streamThinking + buf.thinking
        : this.state.streamThinking,
      ...(buf.thinking ? { streamThinkingComplete: false } : {}),
    });
  }

  /** Drop any pending stream deltas (session switch / disconnect). */
  private clearStreamBuffer() {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    this.streamBuf = null;
  }

  private clearPromptTimeout() {
    if (this.promptTimeoutTimer !== null) {
      clearTimeout(this.promptTimeoutTimer);
      this.promptTimeoutTimer = null;
    }
  }

  private notifyPromptResponse() {
    const submittedPrompt = this.submittedPrompt;
    this.submittedPrompt = null;
    if (submittedPrompt) this.onPromptResponse?.(submittedPrompt);
  }

  private markPromptResponseStarted() {
    if (this.state.promptStatus !== "waiting") return;
    this.ignoreLateRecoveryAgentEnd = false;
    this.clearPromptTimeout();
    this.update({
      promptStatus: "responding",
      promptResponseToken: this.state.promptResponseToken + 1,
    });
    this.notifyPromptResponse();
  }

  private markPromptResponseCompleted() {
    if (this.state.promptStatus !== "waiting") return;
    this.clearPromptTimeout();
    this.update({
      promptStatus: "idle",
      promptResponseToken: this.state.promptResponseToken + 1,
    });
    this.notifyPromptResponse();
  }

  private markPromptFailure(status: "timeout" | "error") {
    if (this.state.promptStatus !== "waiting") return;
    this.clearPromptTimeout();
    this.submittedPrompt = null;
    this.update({
      promptStatus: status,
      promptFailureToken: this.state.promptFailureToken + 1,
    });
  }

  private maybeFinishPromptRecovery() {
    if (
      this.promptRecoveryPending &&
      (this.recoveryAbortAcknowledged ||
        (this.recoveryAgentEnded && this.recoverySnapshotSettled))
    ) {
      this.promptRecoveryPending = false;
      // If the old agent_end was not delivered, ignore one late copy so it
      // cannot complete the retry that follows.
      this.ignoreLateRecoveryAgentEnd = !this.recoveryAgentEnded;
    }
  }

  private startPromptTimeout() {
    this.clearPromptTimeout();
    this.promptTimeoutTimer = setTimeout(() => {
      this.promptTimeoutTimer = null;
      this.promptRecoveryPending = true;
      this.recoveryAgentEnded = false;
      this.recoverySnapshotSettled = false;
      this.recoveryAbortAcknowledged = false;
      this.ignoreLateRecoveryAgentEnd = false;
      if (this.ws?.readyState === WebSocket.OPEN) {
        this.ws.send(JSON.stringify({ type: "abort" } satisfies ClientCommand));
      }
      this.markPromptFailure("timeout");
    }, this.promptResponseTimeoutMs);
  }

  state: ChatState = createInitialState();

  /**
   * Connect to a session. Ignores the call when already attached to the same
   * session; otherwise closes the existing connection and opens a new one.
   * `force: true` — reopen a fresh draft connection even when already on `/`.
   * `cwd` — working directory for a new session (per-project new session).
   */
  connect(sessionId: string | null = null, opts?: { force?: boolean; cwd?: string }) {
    const current = this.state.sessionId ?? this.target;
    const sameTarget = sessionId === null ? this.target === null : sessionId === current;
    const switchingSession = opts?.force || !sameTarget;

    if (!switchingSession && this.ws) return;

    // A reconnect timer captures the old target. Invalidate it before opening
    // anything else so it cannot reclaim the view after a session switch.
    const version = ++this.connectionVersion;
    this.clearReconnectTimer();
    this.clearDisconnectTimer();

    if (this.ws) {
      this.closeSocket();
    }
    if (switchingSession) {
      // This must also run when the previous socket already dropped. Keeping
      // its sessionId lets the connection -> URL effect navigate a fresh
      // draft straight back to that stale session.
      this.clearStreamBuffer();
      this.clearPromptTimeout();
      this.promptAssistantCountAtSend = 0;
      this.submittedPrompt = null;
      this.promptRecoveryPending = false;
      this.recoveryAgentEnded = false;
      this.recoverySnapshotSettled = false;
      this.recoveryAbortAcknowledged = false;
      this.ignoreLateRecoveryAgentEnd = false;
      this.update({
        connection: "connecting",
        snapshot: null,
        sessionId: null,
        streamText: "",
        streamThinking: "",
        streamThinkingComplete: false,
        activeTools: [],
        promptStatus: "idle",
        commands: [],
        commandIntent: null,
        extensionUIRequest: null,
      });
    }
    this.target = sessionId;
    // Explicit cwd wins; an explicit "new session" (force, no cwd) resets the
    // remembered draft directory back to the default.
    if (opts) {
      if (opts.cwd) this.cwd = opts.cwd;
      else if (opts.force && sessionId === null) this.cwd = null;
    }
    if (this.state.connection === "disconnected") {
      this.update({ connection: "connecting" });
    }

    const proto = location.protocol === "https:" ? "wss" : "ws";
    const query = new URLSearchParams();
    const token = authHeaders().authorization?.replace("Bearer ", "");
    if (token) query.set("token", token);
    if (sessionId) query.set("session", sessionId);
    // Include the remembered cwd on reconnects so an unpublished draft stays
    // in the project directory it was created from. Harmless for existing
    // sessions (the server resolves cwd from the session header instead).
    const cwdParam = opts?.cwd ?? this.cwd;
    if (cwdParam) query.set("cwd", cwdParam);
    const ws = new WebSocket(`${proto}://${location.host}/ws?${query}`);
    this.ws = ws;

    ws.onopen = () => {
      if (!this.isCurrentSocket(ws, version)) return;
      this.clearDisconnectTimer();
      this.reconnectDelay = 400;
      this.everConnected = true;
      if (this.promptRecoveryPending) {
        ws.send(JSON.stringify({ type: "abort" } satisfies ClientCommand));
      }
      this.update({ connection: "connected" });
    };
    ws.onmessage = (e) => {
      if (!this.isCurrentSocket(ws, version)) return;
      try {
        this.handle(JSON.parse(e.data) as ServerEvent);
      } catch {
        /* ignore */
      }
    };
    ws.onclose = () => {
      if (!this.isCurrentSocket(ws, version)) return;
      this.ws = null;
      this.clearStreamBuffer();
      if (this.intentionalClose) return;

      // Soft state while retrying — don't flash red on first paint / brief blips.
      if (this.state.connection === "connected") {
        this.update({ connection: "connecting" });
      }
      this.scheduleDisconnected();
      // Reconnect to the currently bound session (don't spawn another new one)
      const retryTarget = this.state.sessionId ?? this.target;
      const delay = this.reconnectDelay;
      this.reconnectDelay = Math.min(Math.round(this.reconnectDelay * 1.6), 8_000);
      // Only 401 (expired session) goes to the login screen; if the server was
      // briefly down (checking) keep reconnecting
      this.reconnectTimer = setTimeout(() => {
        this.reconnectTimer = null;
        if (this.intentionalClose || this.ws || version !== this.connectionVersion) return;
        void checkAuth().then((s) => {
          if (this.intentionalClose || this.ws || version !== this.connectionVersion) return;
          if (s === "unauthenticated") return; // AuthGate shows the login screen
          this.connect(retryTarget);
        });
      }, delay);
    };
    ws.onerror = () => ws.close();
  }

  private isCurrentSocket(ws: WebSocket, version: number): boolean {
    return this.ws === ws && this.connectionVersion === version;
  }

  private clearReconnectTimer() {
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  /** Detach reconnect handlers and close the socket (prevents ghost/reconnect loops) */
  private closeSocket() {
    const ws = this.ws;
    this.ws = null;
    if (!ws) return;
    ws.onopen = null;
    ws.onclose = null;
    ws.onerror = null;
    ws.onmessage = null;
    try {
      ws.close();
    } catch {
      /* ignore */
    }
  }

  /** Stop this session's connection and all of its timers. */
  dispose() {
    this.intentionalClose = true;
    this.connectionVersion += 1;
    this.clearReconnectTimer();
    this.clearDisconnectTimer();
    this.clearStreamBuffer();
    this.clearPromptTimeout();
    this.submittedPrompt = null;
    this.promptRecoveryPending = false;
    this.recoveryAgentEnded = false;
    this.recoverySnapshotSettled = false;
    this.recoveryAbortAcknowledged = false;
    this.ignoreLateRecoveryAgentEnd = false;
    this.closeSocket();
    this.onDispose?.();
  }

  send(cmd: ClientCommand) {
    const socketOpen = this.ws?.readyState === WebSocket.OPEN;
    if (cmd.type === "prompt") {
      if (!socketOpen || this.promptRecoveryPending) {
        this.update({
          promptStatus: "error",
          promptFailureToken: this.state.promptFailureToken + 1,
        });
        return;
      }
      this.promptAssistantCountAtSend =
        this.state.snapshot?.messages.filter((message) => message.role === "assistant").length ?? 0;
      this.submittedPrompt = {
        text: cmd.text.trim(),
        images: [...(cmd.images ?? [])],
      };
      this.update({
        lastError: null,
        promptStatus: "waiting",
      });
      this.startPromptTimeout();
    }
    if (socketOpen) {
      this.ws!.send(JSON.stringify(cmd));
    }
  }

  private scheduleDisconnected() {
    this.clearDisconnectTimer();
    // First load: wait longer before red. After a live session drop: faster.
    const graceMs = this.everConnected ? 1_200 : 4_000;
    this.disconnectTimer = setTimeout(() => {
      if (this.ws?.readyState === WebSocket.OPEN) return;
      this.update({ connection: "disconnected" });
    }, graceMs);
  }

  private clearDisconnectTimer() {
    if (this.disconnectTimer !== null) {
      clearTimeout(this.disconnectTimer);
      this.disconnectTimer = null;
    }
  }

  private handle(event: ServerEvent) {
    // A non-delta event can replace/clear the streaming text (snapshot,
    // agent_end …). Flush pending deltas first so no characters are lost.
    if (event.type !== "delta") this.flushStreamBuffer();
    switch (event.type) {
      case "hello":
        // Show an update banner when the server version differs from the client build
        if (typeof event.version === "string") {
          const updateAvailable = event.version !== __APP_VERSION__;
          this.update({
            updateAvailable,
            updateVersion: updateAvailable ? event.version : null,
            updateNotes: updateAvailable ? (event.updateNotes ?? []) : [],
          });
        }
        break;
      case "session_bound":
        // Once the server hands out the id (first message or existing-session
        // connect), it becomes the workspace key and URL sync target.
        this.target = event.sessionId;
        this.update({ sessionId: event.sessionId });
        this.onSessionBound?.(event.sessionId);
        break;
      case "snapshot":
        if (this.promptRecoveryPending) {
          // Keep the snapshot as evidence for the compatibility fallback;
          // the explicit abort acknowledgement is the reconnect-safe barrier.
          if (!event.snapshot.isStreaming) {
            this.recoverySnapshotSettled = true;
            this.maybeFinishPromptRecovery();
          }
        } else if (event.snapshot.isStreaming) {
          // A reconnect can deliver an active snapshot before agent_start.
          this.markPromptResponseStarted();
        } else if (
          this.state.promptStatus === "waiting" &&
          event.snapshot.messages.filter((message) => message.role === "assistant").length >
            this.promptAssistantCountAtSend
        ) {
          // The run may have finished while the socket was disconnected.
          this.markPromptResponseCompleted();
        }
        // Completed messages are reflected in the snapshot, so clear the stream buffers
        this.update({
          snapshot: event.snapshot,
          streamText: "",
          streamThinking: "",
          streamThinkingComplete: false,
        });
        break;
      case "delta": {
        this.markPromptResponseStarted();
        // Coalesce per-token deltas into one React update per flush window
        // (see DELTA_FLUSH_MS) — rendering once per token is a sustained CPU
        // load on phones (each render re-parses the accumulated markdown).
        const buf = (this.streamBuf ??= {});
        if (event.kind === "text") buf.text = (buf.text ?? "") + event.delta;
        else buf.thinking = (buf.thinking ?? "") + event.delta;
        this.scheduleFlush();
        break;
      }
      case "thinking_end":
        this.markPromptResponseStarted();
        // The agent gives us an explicit end marker, so there is no reason to
        // keep the expanded streaming card around while the response continues.
        this.update({ streamThinkingComplete: true });
        break;
      case "tool_start":
        this.markPromptResponseStarted();
        this.update({
          activeTools: [
            ...this.state.activeTools,
            { toolCallId: event.toolCallId, toolName: event.toolName },
          ],
        });
        break;
      case "tool_end":
        this.update({
          activeTools: this.state.activeTools.filter((t) => t.toolCallId !== event.toolCallId),
        });
        break;
      case "agent_start":
        this.markPromptResponseStarted();
        this.update({
          snapshot: this.state.snapshot ? { ...this.state.snapshot, isStreaming: true } : null,
        });
        break;
      case "agent_end":
        if (this.ignoreLateRecoveryAgentEnd) {
          this.ignoreLateRecoveryAgentEnd = false;
          break;
        }
        notifyTaskComplete();
        // Treat agent_end as a response even when agent_start was lost during a
        // reconnect. This is idempotent when the prompt already responded.
        if (this.promptRecoveryPending) {
          this.recoveryAgentEnded = true;
          this.maybeFinishPromptRecovery();
        } else {
          this.markPromptResponseCompleted();
        }
        // Drop isStreaming before the snapshot arrives so no loading dots linger
        this.update({
          activeTools: [],
          streamText: "",
          streamThinking: "",
          streamThinkingComplete: false,
          promptStatus: this.state.promptStatus === "responding" ? "idle" : this.state.promptStatus,
          snapshot: this.state.snapshot
            ? { ...this.state.snapshot, isStreaming: false }
            : null,
        });
        break;
      case "abort_complete":
        this.recoveryAbortAcknowledged = true;
        this.maybeFinishPromptRecovery();
        break;
      case "forked":
        if (event.selectedText) this.update({ injectText: event.selectedText });
        break;
      case "command_catalog":
        this.update({ commands: event.commands });
        break;
      case "command_result":
        this.markPromptResponseCompleted();
        this.update({ lastNotice: event.message });
        break;
      case "client_action":
        this.markPromptResponseCompleted();
        this.update({ commandIntent: event.action });
        break;
      case "extension_ui_request":
        this.markPromptResponseCompleted();
        this.update({ extensionUIRequest: event.request });
        break;
      case "error":
        if (this.promptRecoveryPending) {
          this.recoveryAgentEnded = true;
          this.maybeFinishPromptRecovery();
        } else {
          this.markPromptFailure("error");
        }
        console.error("[pi-web-chat]", event.message);
        this.update({ lastError: event.message });
        break;
    }
  }

  /** 把历史消息重新填充到输入框 (user 消息的 reuse 按钮) */
  refillComposer(text: string) {
    this.update({ injectText: text });
  }

  consumeInjectText() {
    if (this.state.injectText !== null) this.update({ injectText: null });
  }

  clearError() {
    if (this.state.lastError !== null) this.update({ lastError: null });
  }

  clearNotice() {
    if (this.state.lastNotice !== null) this.update({ lastNotice: null });
  }

  consumeCommandIntent() {
    if (this.state.commandIntent !== null) this.update({ commandIntent: null });
  }

  reportNotice(message: string) {
    this.update({ lastNotice: message });
  }

  reportError(message: string) {
    this.update({ lastError: message });
  }

  respondExtensionUI(response: UIExtensionUIResponse) {
    this.send({ type: "extension_ui_response", response });
    if (this.state.extensionUIRequest?.id === response.id) this.update({ extensionUIRequest: null });
  }

  /** Delay slightly so it doesn't collide with drawer close etc., then focus the composer. */
  requestComposerFocus(isActive: () => boolean = () => true) {
    window.setTimeout(() => {
      if (!isActive()) return;
      this.update({ focusToken: this.state.focusToken + 1 });
    }, 50);
  }

  clearComposerFocus() {
    if (this.state.focusToken > 0) this.update({ focusToken: 0 });
  }

  private update(partial: Partial<ChatState>) {
    this.state = { ...this.state, ...partial };
    for (const l of this.listeners) l();
  }

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getSnapshot = () => this.state;
}

export type ChatTab = WorkspaceTab<ChatState>;

class ChatWorkspaceClient {
  private readonly emptyState = createInitialState();
  private readonly workspace = new SessionWorkspace<ChatState, ChatClient>(
    (_sessionId, onBound, tabKey) =>
      new ChatClient(
        onBound,
        undefined,
        (prompt) => clearComposerDraftIfMatches(tabKey, prompt),
        () => clearComposerDraft(tabKey),
      ),
    (sessionId, active) => {
      // Only the visible session should become the resume target. A background
      // draft may publish while another tab is active.
      if (active) rememberSessionId(sessionId);
    },
  );

  get state(): ChatState {
    return this.workspace.getActiveClient()?.state ?? this.emptyState;
  }

  get activeTabKey(): string | null {
    return this.workspace.activeKey;
  }

  connect(sessionId: string | null = null, opts?: { force?: boolean; cwd?: string }) {
    return this.workspace.open(sessionId, opts);
  }

  activate(tabKey: string): boolean {
    return this.workspace.activate(tabKey);
  }

  closeTab(tabKey: string): ChatTab | null {
    const activeKey = this.workspace.close(tabKey);
    return (
      this.workspace.getTabsSnapshot().find((tab) => tab.key === activeKey) ?? null
    );
  }

  getTabsSnapshot = (): readonly ChatTab[] => this.workspace.getTabsSnapshot();

  subscribe = (listener: () => void) => this.workspace.subscribe(listener);

  getSnapshot = () => this.state;

  // The remaining methods intentionally target the active tab so existing
  // components can keep using the same imperative chatClient surface.
  send(cmd: ClientCommand) {
    this.workspace.getActiveClient()?.send(cmd);
  }

  refillComposer(text: string) {
    this.workspace.getActiveClient()?.refillComposer(text);
  }

  consumeInjectText() {
    this.workspace.getActiveClient()?.consumeInjectText();
  }

  clearError() {
    this.workspace.getActiveClient()?.clearError();
  }

  clearNotice() {
    this.workspace.getActiveClient()?.clearNotice();
  }

  consumeCommandIntent() {
    this.workspace.getActiveClient()?.consumeCommandIntent();
  }

  reportNotice(message: string) {
    this.workspace.getActiveClient()?.reportNotice(message);
  }

  reportNoticeFor(tabKey: string, message: string) {
    this.workspace.getClient(tabKey)?.reportNotice(message);
  }

  reportError(message: string) {
    this.workspace.getActiveClient()?.reportError(message);
  }

  reportErrorFor(tabKey: string, message: string) {
    this.workspace.getClient(tabKey)?.reportError(message);
  }

  respondExtensionUI(response: UIExtensionUIResponse) {
    this.workspace.getActiveClient()?.respondExtensionUI(response);
  }

  requestComposerFocus() {
    const targetKey = this.workspace.activeKey;
    const targetClient = targetKey ? this.workspace.getClient(targetKey) : undefined;
    targetClient?.requestComposerFocus(() => this.workspace.activeKey === targetKey);
  }

  clearComposerFocus() {
    this.workspace.getActiveClient()?.clearComposerFocus();
  }
}

export const chatClient = new ChatWorkspaceClient();

export function useChat(): ChatState {
  return useSyncExternalStore(chatClient.subscribe, chatClient.getSnapshot);
}

export function useChatTabs(): readonly ChatTab[] {
  return useSyncExternalStore(
    chatClient.subscribe,
    chatClient.getTabsSnapshot,
    chatClient.getTabsSnapshot,
  );
}
