import type { UIAgentKind } from "../../shared/protocol";

export interface WorkspaceConnectOptions {
  force?: boolean;
  cwd?: string;
  /** Explicit backend for a brand-new session; existing sessions keep their agent. */
  agent?: UIAgentKind;
}

export interface WorkspaceClientState {
  sessionId: string | null;
  connection: string;
  snapshot: unknown;
}

export interface WorkspaceClient<State extends WorkspaceClientState> {
  state: State;
  connect(sessionId: string | null, opts?: WorkspaceConnectOptions): void;
  dispose(): void;
  /** Clear one-shot UI requests when a client becomes inactive. */
  clearComposerFocus?(): void;
  subscribe(listener: () => void): () => void;
}

export interface WorkspaceTab<State extends WorkspaceClientState> {
  key: string;
  sessionId: string | null;
  state: State;
}

type ClientFactory<Client> = (
  sessionId: string | null,
  onBound: (sessionId: string) => void,
  tabKey: string,
) => Client;

export interface SessionWorkspaceLifecycle {
  onTabClosed?(key: string): void;
  onTabsMerged?(losingKey: string, survivingKey: string): void;
}

/**
 * Keeps one independent client/runtime connection per session tab.
 * The active tab is a view concern; inactive clients stay connected so their
 * streams and reconnect timers continue independently in the background.
 */
export class SessionWorkspace<
  State extends WorkspaceClientState,
  Client extends WorkspaceClient<State>,
> {
  private readonly clients = new Map<string, Client>();
  private readonly unsubscriptions = new Map<string, () => void>();
  private readonly listeners = new Set<() => void>();
  private readonly createClient: ClientFactory<Client>;
  private nextDraftId = 1;
  private activeKeyValue: string | null = null;
  private tabsSnapshot: readonly WorkspaceTab<State>[] = [];

  constructor(
    createClient: ClientFactory<Client>,
    private readonly onSessionBound?: (sessionId: string, active: boolean) => void,
    private readonly lifecycle?: SessionWorkspaceLifecycle,
  ) {
    this.createClient = createClient;
  }

  get activeKey(): string | null {
    return this.activeKeyValue;
  }

  getTabsSnapshot = (): readonly WorkspaceTab<State>[] => this.tabsSnapshot;

  getActiveClient(): Client | undefined {
    return this.activeKeyValue ? this.clients.get(this.activeKeyValue) : undefined;
  }

  getClient(key: string): Client | undefined {
    return this.clients.get(key);
  }

  /** Open an existing session or reuse/create the active draft. */
  open(sessionId: string | null, opts?: WorkspaceConnectOptions): Client {
    if (sessionId) {
      const existingKey =
        this.tabsSnapshot.find((tab) => tab.sessionId === sessionId)?.key ?? sessionId;
      const existing = this.clients.get(existingKey);
      if (existing) {
        this.setActive(existingKey);
        return existing;
      }
      return this.createTab(sessionId, opts);
    }

    const active = this.getActiveClient();
    if (!opts?.force && this.activeKeyValue?.startsWith("draft:") && active) {
      return active;
    }
    return this.createTab(null, opts);
  }

  /** Activate an already-open tab without touching its connection. */
  activate(key: string): boolean {
    if (!this.clients.has(key)) return false;
    this.setActive(key);
    return true;
  }

  /** Close a tab and return the key that became active, if any. */
  close(key: string): string | null {
    const resolvedKey = this.clients.has(key)
      ? key
      : this.tabsSnapshot.find((tab) => tab.sessionId === key)?.key ?? key;
    const client = this.clients.get(resolvedKey);
    if (!client) return this.activeKeyValue;

    const keysBeforeClose = [...this.clients.keys()];
    const wasActive = this.activeKeyValue === resolvedKey;
    const closedIndex = keysBeforeClose.indexOf(resolvedKey);
    this.unsubscriptions.get(resolvedKey)?.();
    this.unsubscriptions.delete(resolvedKey);
    this.clients.delete(resolvedKey);
    client.dispose();

    if (wasActive) {
      const remaining = [...this.clients.keys()];
      this.activeKeyValue =
        remaining[Math.min(Math.max(closedIndex, 0), remaining.length - 1)] ?? null;
    }
    this.refresh();
    this.lifecycle?.onTabClosed?.(resolvedKey);
    return this.activeKeyValue;
  }

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  private createTab(sessionId: string | null, opts?: WorkspaceConnectOptions): Client {
    const key = sessionId ?? `draft:${this.nextDraftId++}`;
    // Keep the tab key in a mutable reference for the bound-session callback.
    // Draft tab keys remain stable across session binding and forks.
    const keyRef = { value: key };
    const client = this.createClient(
      sessionId,
      (boundId) => this.handleBound(keyRef, boundId),
      key,
    );
    this.clients.set(key, client);
    this.unsubscriptions.set(
      key,
      client.subscribe(() => {
        this.refresh();
      }),
    );
    this.clearInactiveFocus(key);
    this.activeKeyValue = key;
    this.refresh();
    client.connect(sessionId, opts);
    return client;
  }

  private clearInactiveFocus(nextKey: string) {
    if (this.activeKeyValue && this.activeKeyValue !== nextKey) {
      this.clients.get(this.activeKeyValue)?.clearComposerFocus?.();
    }
  }

  private setActive(key: string) {
    if (this.activeKeyValue === key) return;
    this.clearInactiveFocus(key);
    this.activeKeyValue = key;
    this.refresh();
  }

  private handleBound(keyRef: { value: string }, boundId: string) {
    const tabKey = keyRef.value;
    const client = this.clients.get(tabKey);
    if (!client) return;

    const wasActive = this.activeKeyValue === tabKey;
    const existingKey =
      this.tabsSnapshot.find((tab) => tab.sessionId === boundId)?.key ?? boundId;
    const existing = this.clients.get(existingKey);
    const merged = existing && existing !== client;
    if (merged) {
      this.unsubscriptions.get(tabKey)?.();
      this.unsubscriptions.delete(tabKey);
      this.clients.delete(tabKey);
      client.dispose();
      if (wasActive) this.activeKeyValue = existingKey;
    }

    // Keep the UI tab key stable. The bound session id is derived from the
    // client's state, so composer drafts and pending prompt state survive the
    // server's draft -> session transition.
    this.refresh();
    this.onSessionBound?.(boundId, this.activeKeyValue === tabKey);

    if (merged) {
      this.lifecycle?.onTabsMerged?.(tabKey, existingKey);
    }
  }

  private refresh() {
    this.tabsSnapshot = [...this.clients.entries()].map(([key, client]) => ({
      key,
      sessionId: client.state.sessionId ?? (key.startsWith("draft:") ? null : key),
      state: client.state,
    }));
    for (const listener of this.listeners) listener();
  }
}
