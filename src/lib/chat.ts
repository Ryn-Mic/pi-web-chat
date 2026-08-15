import { useSyncExternalStore } from "react";
import type {
  ClientCommand,
  ServerEvent,
  UIClientAction,
  UICommandInfo,
  UIExtensionUIRequest,
  UIExtensionUIResponse,
  UIHistoryPage,
  UIMessageAnchor,
  UIMessageAnchorsResponse,
  UIMessage,
  UISnapshot,
} from "../../shared/protocol";
import { applySnapshotDelta } from "../../shared/snapshot";
import { authHeaders, checkAuth } from "./auth";
import {
  clearComposerDraft,
  type SubmittedComposerPrompt,
} from "./composer-drafts";
import { notifyTaskComplete } from "./browserNotifications";
import { rememberSessionId } from "./resume";
import {
  clearPreviewWorkspace,
  mergePreviewWorkspace,
} from "./file-preview";
import {
  SessionWorkspace,
  type WorkspaceClient,
  type WorkspaceTab,
} from "./session-workspace";

export interface ActiveTool {
  toolCallId: string;
  toolName: string;
}

type FrameHost = {
  requestAnimationFrame?: (callback: () => void) => number;
  cancelAnimationFrame?: (handle: number) => void;
};

/**
 * Run `callback` on the next animation frame; returns a canceller.
 *
 * Falls back to a macrotask outside the browser (unit tests, SSR) so the
 * scheduling logic stays testable without a DOM.
 */
function onNextFrame(callback: () => void): () => void {
  const host = globalThis as FrameHost;
  if (typeof host.requestAnimationFrame === "function") {
    const handle = host.requestAnimationFrame(callback);
    return () => host.cancelAnimationFrame?.(handle);
  }
  const timer = setTimeout(callback, 0);
  return () => clearTimeout(timer);
}

/** Run `callback` after `ms`; returns a canceller. */
function afterDelay(ms: number, callback: () => void): () => void {
  const timer = setTimeout(callback, ms);
  return () => clearTimeout(timer);
}

/** WS lifecycle for chrome status (avoid red flash on first paint). */
export type ConnectionStatus = "connecting" | "connected" | "disconnected";
export type PromptStatus = "idle" | "sending" | "accepted" | "running";

export interface ChatState {
  connection: ConnectionStatus;
  /** Session id the server bound to this connection (for URL sync) */
  sessionId: string | null;
  snapshot: UISnapshot | null;
  /** Pages loaded before the fixed live snapshot window. */
  historicalMessages: UIMessage[];
  historyCursor: string | null;
  historyHasMore: boolean;
  historyLoading: boolean;
  /** Assistant text streaming right now (not yet in the snapshot) */
  streamText: string;
  streamThinking: string;
  /** The live thinking block has finished and should be collapsed immediately. */
  streamThinkingComplete: boolean;
  activeTools: ActiveTool[];
  /** Text to inject into the composer (fork refill = replace; file reference = insert) — cleared after consumption */
  injectText: { text: string; mode: "replace" | "insert" } | null;
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
  /** User input rendered locally until the server snapshot persists it. */
  optimisticMessages: UIMessage[];
  /** Prompt restored after the server explicitly rejects processing it. */
  restorePrompt: SubmittedComposerPrompt | null;
  /** Transport and agent lifecycle of the current prompt. */
  promptStatus: PromptStatus;
  /** Incremented when the server accepts or persists the current prompt. */
  promptAcceptedToken: number;
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
    historicalMessages: [],
    historyCursor: null,
    historyHasMore: false,
    historyLoading: false,
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
    optimisticMessages: [],
    restorePrompt: null,
    promptStatus: "idle",
    promptAcceptedToken: 0,
    lastNotice: null,
    commandIntent: null,
    commands: [],
    extensionUIRequest: null,
  };
}

export class ChatClient implements WorkspaceClient<ChatState> {
  constructor(
    private readonly onSessionBound?: (sessionId: string) => void,
    private readonly onDispose?: () => void,
  ) {}

  private ws: WebSocket | null = null;
  private listeners = new Set<() => void>();
  /** State events collapse into one subscriber notification per microtask. */
  private notifyScheduled = false;
  /** Invalidates an already queued (and therefore uncancellable) microtask. */
  private notifyGeneration = 0;
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
  private pendingPrompt: {
    requestId: string;
    command: Extract<ClientCommand, { type: "prompt" }>;
    submitted: SubmittedComposerPrompt;
    userCountAtSend: number;
    awaitingReceipt: boolean;
  } | null = null;
  /** Prompt metadata used to reconcile the optimistic message with snapshots. */
  private optimisticSubmitted: SubmittedComposerPrompt | null = null;
  private optimisticUserCountAtSend = 0;
  /** Full snapshot revision currently installed in state.snapshot. */
  private snapshotRevision: number | null = null;
  /** Last contiguous per-session event installed by this client. */
  private eventSeq: number | null = null;
  private eventSyncPending = false;
  /** Avoid spamming get_snapshot while waiting for one gap repair response. */
  private snapshotResyncPending = false;

  /**
   * Stream deltas coalesced here and flushed on a two-tier cadence, mirroring
   * DSH's Notifier split:
   *
   * - State events (snapshot / tool_end / agent_end …) flush synchronously at the
   *   top of {@link handle} — they must never be deferred.
   * - Visual deltas coalesce onto an animation frame, rate-capped to
   *   {@link DELTA_FLUSH_MS}. Fast models emit ~100 delta frames/s and every
   *   flush re-renders the whole MessageList, so rendering per token is a
   *   sustained CPU load on phones (heat / battery drain).
   *
   * The first delta after a quiet period is not delayed: it flushes on the next
   * frame so the response starts painting immediately instead of 100ms late.
   * Using an animation frame also means a hidden tab stops re-rendering — deltas
   * keep accumulating and land in a single flush when it becomes visible again.
   */
  private static readonly DELTA_FLUSH_MS = 100;
  private streamBuf: { text?: string; thinking?: string } | null = null;
  private flushHandle: (() => void) | null = null;
  /** Timestamp of the last flush that actually applied deltas. */
  private lastFlushAt = 0;

  private scheduleFlush() {
    if (this.flushHandle) return;
    const run = () => {
      this.flushHandle = null;
      this.flushStreamBuffer();
    };
    const elapsed = Date.now() - this.lastFlushAt;
    const wait = Math.max(0, ChatClient.DELTA_FLUSH_MS - elapsed);
    this.flushHandle = wait > 0 ? afterDelay(wait, run) : onNextFrame(run);
  }

  /** Apply buffered deltas to state and stop the timer. */
  private flushStreamBuffer() {
    this.cancelScheduledFlush();
    const buf = this.streamBuf;
    this.streamBuf = null;
    if (!buf) return;
    // Only a flush that applied deltas resets the rate window; otherwise the
    // frequent state events would keep pushing the next delta 100ms out.
    this.lastFlushAt = Date.now();
    this.update({
      streamText: buf.text ? this.state.streamText + buf.text : this.state.streamText,
      streamThinking: buf.thinking
        ? this.state.streamThinking + buf.thinking
        : this.state.streamThinking,
      ...(buf.thinking ? { streamThinkingComplete: false } : {}),
    });
  }

  private cancelScheduledFlush() {
    if (this.flushHandle) {
      this.flushHandle();
      this.flushHandle = null;
    }
  }

  /** Drop any pending stream deltas (session switch / disconnect). */
  private clearStreamBuffer() {
    this.cancelScheduledFlush();
    this.streamBuf = null;
  }

  private createRequestId(): string {
    return crypto.randomUUID();
  }

  private markPromptRunning() {
    if (
      !this.pendingPrompt ||
      this.state.promptStatus === "idle" ||
      this.state.promptStatus === "running"
    )
      return;
    this.update({ promptStatus: "running" });
  }

  private settlePrompt() {
    if (this.state.promptStatus !== "idle") this.update({ promptStatus: "idle" });
  }

  private reconcileOptimisticMessage(snapshot: UISnapshot) {
    const pending = this.pendingPrompt;
    const submitted = pending?.submitted ?? this.optimisticSubmitted;
    if (!submitted) return;
    const userMessages = snapshot.messages.filter((message) => message.role === "user");
    const newMessages = userMessages.slice(pending?.userCountAtSend ?? this.optimisticUserCountAtSend);
    const matches = newMessages.some((message) => {
      const text = message.content
        .filter((block): block is Extract<UIMessage["content"][number], { type: "text" }> => block.type === "text")
        .map((block) => block.text)
        .join("\n");
      const images = message.content.filter(
        (block): block is Extract<UIMessage["content"][number], { type: "image" }> => block.type === "image",
      );
      return (
        text === submitted.text &&
        images.length === submitted.images.length &&
        images.every(
          (image, index) =>
            image.dataUrl ===
            `data:${submitted.images[index]?.mimeType};base64,${submitted.images[index]?.data}`,
        )
      );
    });
    if (!matches) return;
    this.pendingPrompt = null;
    this.optimisticSubmitted = null;
    this.update({
      optimisticMessages: [],
      restorePrompt: null,
      promptAcceptedToken: this.state.promptAcceptedToken + 1,
      ...(snapshot.isStreaming ? {} : { promptStatus: "idle" as const }),
    });
  }

  private discardOptimisticMessage() {
    this.pendingPrompt = null;
    this.optimisticSubmitted = null;
    if (this.state.optimisticMessages.length > 0) this.update({ optimisticMessages: [] });
  }

  private markPromptFailed(message: string, requestId?: string) {
    if (requestId && this.pendingPrompt?.requestId !== requestId) {
      this.update({ lastError: message });
      return;
    }
    const submitted = this.pendingPrompt?.submitted ?? this.optimisticSubmitted;
    this.pendingPrompt = null;
    this.optimisticSubmitted = null;
    this.settlePrompt();
    this.update({
      lastError: message,
      restorePrompt: submitted,
      optimisticMessages: this.state.optimisticMessages.map((optimistic) => ({
        ...optimistic,
        errorMessage: message,
      })),
    });
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
      this.pendingPrompt = null;
      this.optimisticSubmitted = null;
      this.snapshotRevision = null;
      this.eventSeq = null;
      this.eventSyncPending = false;
      this.snapshotResyncPending = false;
      this.update({
        connection: "connecting",
        snapshot: null,
        historicalMessages: [],
        historyCursor: null,
        historyHasMore: false,
        historyLoading: false,
        sessionId: null,
        streamText: "",
        streamThinking: "",
        streamThinkingComplete: false,
        activeTools: [],
        optimisticMessages: [],
        restorePrompt: null,
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
    if (!switchingSession && sessionId && this.eventSeq !== null) {
      query.set("since", String(this.eventSeq));
    }
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
      this.update({ connection: "connected" });
      // A dropped WebSocket has no delivery acknowledgement. Replaying the
      // same request id is safe because the server deduplicates it.
      if (this.pendingPrompt?.awaitingReceipt) {
        ws.send(JSON.stringify(this.pendingPrompt.command));
      }
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
    this.pendingPrompt = null;
    this.optimisticSubmitted = null;
    this.update({ restorePrompt: null });
    this.closeSocket();
    this.onDispose?.();
  }

  async loadOlderMessages(): Promise<boolean> {
    const sessionId = this.state.sessionId;
    const cursor = this.state.historyCursor;
    if (!sessionId || !cursor || !this.state.historyHasMore || this.state.historyLoading) {
      return false;
    }

    this.update({ historyLoading: true });
    try {
      const query = new URLSearchParams({ cursor });
      const url = `/api/sessions/${encodeURIComponent(sessionId)}/history?${query}`;
      const response = await fetch(url, { headers: authHeaders() });
      if (!response.ok) throw new Error(`history request failed: ${response.status}`);
      const page = (await response.json()) as UIHistoryPage;
      // Ignore a response that outlived a tab/session switch or a second cursor.
      if (this.state.sessionId !== sessionId || this.state.historyCursor !== cursor) return false;
      this.update({
        historicalMessages: [...page.messages, ...this.state.historicalMessages],
        historyCursor: page.cursor,
        historyHasMore: page.hasMore,
        historyLoading: false,
      });
      return true;
    } catch {
      if (this.state.sessionId === sessionId && this.state.historyCursor === cursor) {
        this.update({ historyLoading: false });
      }
      return false;
    }
  }

  /** Fetch lightweight user-message metadata without loading transcript pages. */
  async loadMessageAnchors(): Promise<UIMessageAnchor[] | null> {
    const sessionId = this.state.sessionId;
    if (!sessionId) return [];
    try {
      const response = await fetch(
        `/api/sessions/${encodeURIComponent(sessionId)}/anchors`,
        { headers: authHeaders() },
      );
      if (!response.ok) throw new Error(`message anchor request failed: ${response.status}`);
      const body = (await response.json()) as UIMessageAnchorsResponse;
      if (this.state.sessionId !== sessionId || !Array.isArray(body.anchors)) return null;
      return body.anchors;
    } catch {
      return null;
    }
  }

  private loadedPersistedUserMessages(): number {
    const live = this.state.snapshot?.messages ?? [];
    return [...this.state.historicalMessages, ...live].reduce(
      (count, message) => count + (message.role === "user" ? 1 : 0),
      0,
    );
  }

  /** Load only enough older pages to make one indexed user message available. */
  async loadHistoryThroughUserMessage(
    ordinal: number,
    totalUserMessages: number,
  ): Promise<boolean> {
    if (
      !Number.isSafeInteger(ordinal) ||
      !Number.isSafeInteger(totalUserMessages) ||
      ordinal < 1 ||
      ordinal > totalUserMessages
    ) {
      return false;
    }
    const sessionId = this.state.sessionId;
    const requiredLoadedUsers = totalUserMessages - ordinal + 1;
    while (
      sessionId !== null &&
      this.state.sessionId === sessionId &&
      this.loadedPersistedUserMessages() < requiredLoadedUsers &&
      this.state.historyHasMore
    ) {
      const pageLoaded = await this.loadOlderMessages();
      if (!pageLoaded) break;
    }
    return (
      sessionId !== null &&
      this.state.sessionId === sessionId &&
      this.loadedPersistedUserMessages() >= requiredLoadedUsers
    );
  }

  send(cmd: ClientCommand): boolean {
    const socketOpen = this.ws?.readyState === WebSocket.OPEN;
    if (cmd.type === "prompt") {
      if (!socketOpen || this.pendingPrompt) {
        this.update({
          lastError: socketOpen
            ? "A prompt is already being sent."
            : "Reconnecting. Please wait before sending.",
        });
        return false;
      }
      const requestId = cmd.requestId ?? this.createRequestId();
      const command = { ...cmd, requestId };
      const submitted: SubmittedComposerPrompt = {
        text: command.text.trim(),
        images: [...(command.images ?? [])],
      };
      const optimisticMessage: UIMessage = {
        role: "user",
        content: [
          ...(submitted.text ? [{ type: "text" as const, text: submitted.text }] : []),
          ...submitted.images.map((image) => ({
            type: "image" as const,
            dataUrl: `data:${image.mimeType};base64,${image.data}`,
          })),
        ],
        timestamp: Date.now(),
      };
      const userCountAtSend =
        this.state.snapshot?.messages.filter((message) => message.role === "user").length ?? 0;
      this.optimisticSubmitted = submitted;
      this.optimisticUserCountAtSend = userCountAtSend;
      this.pendingPrompt = {
        requestId,
        command,
        submitted,
        userCountAtSend,
        awaitingReceipt: true,
      };
      this.update({
        lastError: null,
        optimisticMessages: [optimisticMessage],
        restorePrompt: null,
        promptStatus: "sending",
      });
      try {
        this.ws!.send(JSON.stringify(command));
        return true;
      } catch {
        this.discardOptimisticMessage();
        this.update({
          lastError: "The connection closed before the prompt could be sent.",
          promptStatus: "idle",
        });
        return false;
      }
    }
    if (socketOpen) this.ws!.send(JSON.stringify(cmd));
    return socketOpen;
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

  private requestEventSync() {
    if (
      this.eventSyncPending ||
      this.eventSeq === null ||
      this.ws?.readyState !== WebSocket.OPEN
    )
      return;
    this.eventSyncPending = true;
    this.ws.send(
      JSON.stringify({ type: "sync_events", afterSeq: this.eventSeq } satisfies ClientCommand),
    );
  }

  private requestFullSnapshot() {
    if (this.snapshotResyncPending || this.ws?.readyState !== WebSocket.OPEN) return;
    this.snapshotResyncPending = true;
    this.ws.send(JSON.stringify({ type: "get_snapshot" } satisfies ClientCommand));
  }

  private acceptSequence(event: ServerEvent): boolean {
    if (event.type === "snapshot") {
      this.eventSeq = event.seq;
      this.eventSyncPending = false;
      return true;
    }
    if (!("seq" in event)) return true;
    if (this.eventSeq === null) {
      this.requestFullSnapshot();
      return false;
    }
    if (event.seq <= this.eventSeq) return false;
    if (event.seq !== this.eventSeq + 1) {
      this.requestEventSync();
      return false;
    }
    this.eventSeq = event.seq;
    this.eventSyncPending = false;
    return true;
  }

  private installSnapshot(snapshot: UISnapshot, revision: number, resetHistory = false) {
    this.snapshotRevision = revision;
    this.snapshotResyncPending = false;
    if (snapshot.isStreaming) this.markPromptRunning();
    this.reconcileOptimisticMessage(snapshot);
    // Completed messages are reflected in the snapshot, so clear live buffers.
    this.update({
      snapshot,
      ...(resetHistory
        ? {
            historicalMessages: [],
            historyCursor: snapshot.history?.cursor ?? null,
            historyHasMore: snapshot.history?.hasMore ?? false,
            historyLoading: false,
          }
        : {}),
      activeTools: snapshot.activeTools ?? (resetHistory ? [] : this.state.activeTools),
      streamText: "",
      streamThinking: "",
      streamThinkingComplete: false,
    });
  }

  private handle(event: ServerEvent) {
    if (!this.acceptSequence(event)) return;
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
        this.installSnapshot(event.snapshot, event.revision, true);
        break;
      case "snapshot_delta": {
        const snapshot = applySnapshotDelta(
          this.state.snapshot,
          this.snapshotRevision,
          event.delta,
        );
        if (!snapshot) {
          this.requestFullSnapshot();
          break;
        }
        this.installSnapshot(snapshot, event.delta.revision);
        break;
      }
      case "prompt_received":
        if (this.pendingPrompt?.requestId === event.requestId) {
          this.pendingPrompt.awaitingReceipt = false;
          this.update({
            promptAcceptedToken: this.state.promptAcceptedToken + 1,
            ...(this.state.promptStatus === "sending" ? { promptStatus: "accepted" } : {}),
          });
        }
        break;
      case "delta": {
        this.markPromptRunning();
        // Coalesce per-token deltas into one React update per flush window (see
        // DELTA_FLUSH_MS) — every flush re-renders the whole MessageList, which
        // is a sustained CPU load on phones when done per token.
        const buf = (this.streamBuf ??= {});
        if (event.kind === "text") buf.text = (buf.text ?? "") + event.delta;
        else buf.thinking = (buf.thinking ?? "") + event.delta;
        this.scheduleFlush();
        break;
      }
      case "thinking_end":
        this.markPromptRunning();
        // The agent gives us an explicit end marker, so there is no reason to
        // keep the expanded streaming card around while the response continues.
        this.update({ streamThinkingComplete: true });
        break;
      case "tool_start":
        this.markPromptRunning();
        this.update({
          activeTools: [
            ...this.state.activeTools,
            { toolCallId: event.toolCallId, toolName: event.toolName },
          ],
          ...(event.activeTodo && this.state.snapshot
            ? { snapshot: { ...this.state.snapshot, activeTodo: event.activeTodo } }
            : {}),
        });
        break;
      case "tool_end":
        this.update({
          activeTools: this.state.activeTools.filter((t) => t.toolCallId !== event.toolCallId),
        });
        break;
      case "agent_start":
        this.markPromptRunning();
        this.update({
          snapshot: this.state.snapshot ? { ...this.state.snapshot, isStreaming: true } : null,
        });
        break;
      case "agent_end":
        notifyTaskComplete();
        // agent_end is the runtime's definitive turn boundary. Release the
        // composer immediately; keep optimisticSubmitted until the following
        // snapshot reconciles the local user message without duplication.
        this.pendingPrompt = null;
        this.discardOptimisticMessage();
        this.settlePrompt();
        // Drop isStreaming before the snapshot arrives so no loading dots linger.
        this.update({
          activeTools: [],
          streamText: "",
          streamThinking: "",
          streamThinkingComplete: false,
          snapshot: this.state.snapshot
            ? { ...this.state.snapshot, isStreaming: false }
            : null,
        });
        break;
      case "abort_complete":
        this.pendingPrompt = null;
        this.discardOptimisticMessage();
        this.settlePrompt();
        break;
      case "forked":
        if (event.selectedText)
          this.update({ injectText: { text: event.selectedText, mode: "replace" } });
        break;
      case "command_catalog":
        this.update({ commands: event.commands });
        break;
      case "command_result":
        this.pendingPrompt = null;
        this.discardOptimisticMessage();
        this.settlePrompt();
        this.update({ lastNotice: event.message });
        break;
      case "client_action":
        this.pendingPrompt = null;
        this.discardOptimisticMessage();
        this.settlePrompt();
        this.update({ commandIntent: event.action });
        break;
      case "extension_ui_request":
        this.pendingPrompt = null;
        this.discardOptimisticMessage();
        this.settlePrompt();
        this.update({ extensionUIRequest: event.request });
        break;
      case "error":
        console.error("[pi-web-chat]", event.message);
        if (!event.requestId && this.pendingPrompt) {
          this.update({ lastError: event.message });
        } else {
          this.markPromptFailed(event.message, event.requestId);
        }
        break;
    }
  }

  /** 把历史消息重新填充到输入框 (user 消息的 reuse 按钮) */
  refillComposer(text: string) {
    this.update({ injectText: { text, mode: "replace" } });
  }

  /** Insert text at the composer caret (file references from the tree panel). */
  insertComposerText(text: string) {
    this.update({ injectText: { text, mode: "insert" } });
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
    this.scheduleNotify();
  }

  /**
   * Publish ordinary state changes once per microtask. WebSocket handlers often
   * make several related updates (flush stream, settle prompt, install
   * snapshot); subscribers should only observe their final coherent state.
   */
  private scheduleNotify() {
    if (this.notifyScheduled || this.listeners.size === 0) return;
    this.notifyScheduled = true;
    const generation = ++this.notifyGeneration;
    queueMicrotask(() => {
      if (!this.notifyScheduled || this.notifyGeneration !== generation) return;
      this.notifyScheduled = false;
      for (const listener of this.listeners) listener();
    });
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
        () => clearComposerDraft(tabKey),
      ),
    (sessionId, active) => {
      // Only the visible session should become the resume target. A background
      // draft may publish while another tab is active.
      if (active) rememberSessionId(sessionId);
    },
    {
      onTabClosed: (key) => clearPreviewWorkspace(key),
      onTabsMerged: (losing, surviving) =>
        mergePreviewWorkspace(losing, surviving),
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
  send(cmd: ClientCommand): boolean {
    return this.workspace.getActiveClient()?.send(cmd) ?? false;
  }

  loadOlderMessages(): Promise<boolean> {
    return this.workspace.getActiveClient()?.loadOlderMessages() ?? Promise.resolve(false);
  }

  loadMessageAnchors(): Promise<UIMessageAnchor[] | null> {
    const client = this.workspace.getActiveClient();
    return client?.loadMessageAnchors() ?? Promise.resolve([]);
  }

  loadHistoryThroughUserMessage(
    ordinal: number,
    totalUserMessages: number,
  ): Promise<boolean> {
    const client = this.workspace.getActiveClient();
    return (
      client?.loadHistoryThroughUserMessage(ordinal, totalUserMessages) ??
      Promise.resolve(false)
    );
  }

  refillComposer(text: string) {
    this.workspace.getActiveClient()?.refillComposer(text);
  }

  insertComposerText(text: string) {
    this.workspace.getActiveClient()?.insertComposerText(text);
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
