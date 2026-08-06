import { useSyncExternalStore } from "react";
import type { ClientCommand, ServerEvent, UISnapshot } from "../../shared/protocol";
import { authHeaders, checkAuth } from "./auth";
import { rememberSessionId } from "./resume";

export interface ActiveTool {
  toolCallId: string;
  toolName: string;
}

/** WS lifecycle for chrome status (avoid red flash on first paint). */
export type ConnectionStatus = "connecting" | "connected" | "disconnected";

export interface ChatState {
  connection: ConnectionStatus;
  /** Session id the server bound to this connection (for URL sync) */
  sessionId: string | null;
  snapshot: UISnapshot | null;
  /** Assistant text streaming right now (not yet in the snapshot) */
  streamText: string;
  streamThinking: string;
  activeTools: ActiveTool[];
  /** Text to inject into the composer right after a fork (cleared after consumption) */
  injectText: string | null;
  /** Incremented to focus the composer textarea */
  focusToken: number;
  /** Server version differs from the client build → prompt a reload */
  updateAvailable: boolean;
  /** Error event from the server (failed prompt etc.) — shown as a banner */
  lastError: string | null;
}

const initialState: ChatState = {
  connection: "connecting",
  sessionId: null,
  snapshot: null,
  streamText: "",
  streamThinking: "",
  activeTools: [],
  injectText: null,
  focusToken: 0,
  updateAvailable: false,
  lastError: null,
};

class ChatClient {
  private ws: WebSocket | null = null;
  private listeners = new Set<() => void>();
  private reconnectDelay = 400;
  private intentionalClose = false;
  /** After a drop, stay on "connecting" briefly before showing disconnected. */
  private disconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private everConnected = false;
  /** Session id to connect to (null = new session) */
  private target: string | null = null;
  state: ChatState = initialState;

  /**
   * Connect to a session. Ignores the call when already attached to the same
   * session; otherwise closes the existing connection and opens a new one.
   * `force: true` — reopen a fresh draft connection even when already on `/`.
   * `cwd` — working directory for a new session (per-project new session).
   */
  connect(sessionId: string | null = null, opts?: { force?: boolean; cwd?: string }) {
    if (this.ws) {
      const current = this.state.sessionId ?? this.target;
      if (!opts?.force && (sessionId === null ? this.target === null : sessionId === current)) {
        return;
      }
      // Session switch: close the previous connection and reset the view
      this.closeSocket();
      this.update({
        snapshot: null,
        sessionId: null,
        streamText: "",
        streamThinking: "",
        activeTools: [],
      });
    }
    this.target = sessionId;
    if (this.state.connection === "disconnected") {
      this.update({ connection: "connecting" });
    }

    const proto = location.protocol === "https:" ? "wss" : "ws";
    const query = new URLSearchParams();
    const token = authHeaders().authorization?.replace("Bearer ", "");
    if (token) query.set("token", token);
    if (sessionId) query.set("session", sessionId);
    if (opts?.cwd) query.set("cwd", opts.cwd);
    const ws = new WebSocket(`${proto}://${location.host}/ws?${query}`);
    this.ws = ws;

    ws.onopen = () => {
      this.clearDisconnectTimer();
      this.reconnectDelay = 400;
      this.everConnected = true;
      this.update({ connection: "connected" });
    };
    ws.onmessage = (e) => {
      try {
        this.handle(JSON.parse(e.data) as ServerEvent);
      } catch {
        /* ignore */
      }
    };
    ws.onclose = () => {
      this.ws = null;
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
      setTimeout(() => {
        if (this.intentionalClose || this.ws) return;
        void checkAuth().then((s) => {
          if (this.intentionalClose || this.ws) return;
          if (s === "unauthenticated") return; // AuthGate shows the login screen
          this.target = retryTarget;
          this.connect(retryTarget);
        });
      }, delay);
    };
    ws.onerror = () => ws.close();
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

  send(cmd: ClientCommand) {
    if (cmd.type === "prompt") this.update({ lastError: null });
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(cmd));
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
    switch (event.type) {
      case "hello":
        // Show an update banner when the server version differs from the client build
        if (typeof event.version === "string" && event.version !== __APP_VERSION__) {
          this.update({ updateAvailable: true });
        }
        break;
      case "session_bound":
        // Once the server hands out the id (first message or existing-session
        // connect), it becomes the URL sync target
        this.target = event.sessionId;
        this.update({ sessionId: event.sessionId });
        rememberSessionId(event.sessionId);
        break;
      case "snapshot":
        // Completed messages are reflected in the snapshot, so clear the stream buffers
        this.update({ snapshot: event.snapshot, streamText: "", streamThinking: "" });
        break;
      case "delta":
        if (event.kind === "text") {
          this.update({ streamText: this.state.streamText + event.delta });
        } else {
          this.update({ streamThinking: this.state.streamThinking + event.delta });
        }
        break;
      case "tool_start":
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
        this.update({
          snapshot: this.state.snapshot ? { ...this.state.snapshot, isStreaming: true } : null,
        });
        break;
      case "agent_end":
        // Drop isStreaming before the snapshot arrives so no loading dots linger
        this.update({
          activeTools: [],
          streamText: "",
          streamThinking: "",
          snapshot: this.state.snapshot
            ? { ...this.state.snapshot, isStreaming: false }
            : null,
        });
        break;
      case "forked":
        if (event.selectedText) this.update({ injectText: event.selectedText });
        break;
      case "error":
        console.error("[pi-web-chat]", event.message);
        this.update({ lastError: event.message });
        break;
    }
  }

  consumeInjectText() {
    if (this.state.injectText !== null) this.update({ injectText: null });
  }

  clearError() {
    if (this.state.lastError !== null) this.update({ lastError: null });
  }

  /** Delay slightly so it doesn't collide with drawer close etc., then focus the composer */
  requestComposerFocus() {
    window.setTimeout(() => {
      this.update({ focusToken: this.state.focusToken + 1 });
    }, 50);
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

export const chatClient = new ChatClient();

export function useChat(): ChatState {
  return useSyncExternalStore(chatClient.subscribe, chatClient.getSnapshot);
}
