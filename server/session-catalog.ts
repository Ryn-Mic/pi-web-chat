import { randomUUID } from "node:crypto";
import type { UISessionInfo, UISessionsPage } from "../shared/protocol.ts";

type CatalogLoader = (publish: (sessions: UISessionInfo[]) => void) => Promise<UISessionInfo[]>;
type CatalogOptions = {
  refreshMs?: number;
  snapshotTtlMs?: number;
  now?: () => number;
  transform?: (sessions: UISessionInfo[]) => UISessionInfo[];
};

export class SessionCatalogCursorError extends Error {}

/** Background discovery is independent of HTTP response and pagination lifetimes. */
export class SessionCatalog {
  private readonly sources = new Map<string, Map<string, UISessionInfo>>();
  private readonly snapshots = new Map<string, { at: number; sessions: UISessionInfo[] }>();
  private refreshTask: Promise<void> | null = null;
  private refreshedAt = -Infinity;
  private partialFailure = false;
  private invalidatedDuringRefresh = false;
  private readonly now: () => number;

  constructor(private readonly loaders: Record<string, CatalogLoader>, private readonly options: CatalogOptions = {}) {
    this.now = options.now ?? Date.now;
  }

  invalidate(): void {
    this.refreshedAt = -Infinity;
    if (this.refreshTask) this.invalidatedDuringRefresh = true;
  }

  /** Tests and callers that require reconciliation may await this; pages never do. */
  refresh(): Promise<void> {
    if (this.refreshTask) return this.refreshTask;
    this.partialFailure = false;
    const task = Promise.all(Object.entries(this.loaders).map(async ([source, load]) => {
      try {
        const result = await load((batch) => {
          // Keep a previous warm catalog visible until discovery has completed.
          const known = this.sources.get(source) ?? new Map<string, UISessionInfo>();
          for (const session of batch) known.set(session.id, session);
          this.sources.set(source, known);
        });
        this.sources.set(source, new Map(result.map((session) => [session.id, session])));
      } catch {
        this.partialFailure = true;
      }
    })).then(() => {
      this.refreshedAt = this.invalidatedDuringRefresh ? -Infinity : this.now();
      this.invalidatedDuringRefresh = false;
    }).finally(() => {
      if (this.refreshTask === task) this.refreshTask = null;
    });
    this.refreshTask = task;
    return task;
  }

  page({ limit = 40, cursor, query = "", refresh = false }: { limit?: number; cursor?: string | null; query?: string; refresh?: boolean } = {}): UISessionsPage {
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new SessionCatalogCursorError("Invalid page size");
    const now = this.now();
    for (const [id, snapshot] of this.snapshots) {
      if (now - snapshot.at > (this.options.snapshotTtlMs ?? 120_000)) this.snapshots.delete(id);
    }
    let sessions: UISessionInfo[];
    let id: string;
    let offset = 0;
    if (cursor) {
      const match = /^catalog:([\da-f-]{36}):(\d+)$/.exec(cursor);
      const snapshot = match && this.snapshots.get(match[1]!);
      offset = match ? Number(match[2]) : -1;
      if (!snapshot || !Number.isSafeInteger(offset) || offset < 1 || offset >= snapshot.sessions.length) {
        throw new SessionCatalogCursorError("Session page expired");
      }
      id = match![1]!;
      sessions = snapshot.sessions;
    } else {
      if (!this.refreshTask && (refresh || now - this.refreshedAt >= (this.partialFailure ? 15_000 : this.options.refreshMs ?? 5_000))) void this.refresh();
      const known = [...this.sources.values()].flatMap((source) => [...source.values()]);
      const transformed = this.options.transform ? this.options.transform(known) : known;
      sessions = [...new Map(transformed.map((session) => [session.id, { ...session }])).values()]
        .sort((a, b) => Date.parse(b.modified) - Date.parse(a.modified) || a.id.localeCompare(b.id));
      const normalized = query.trim().toLowerCase();
      if (normalized) sessions = sessions.filter((session) =>
        [session.name, session.firstMessage, session.project, session.id].some((value) => value?.toLowerCase().includes(normalized)));
      id = randomUUID();
      if (sessions.length > limit) {
        // Bound memory even when a client repeatedly requests a fresh first page.
        let retainedRows = [...this.snapshots.values()].reduce((count, snapshot) => count + snapshot.sessions.length, 0);
        while (this.snapshots.size && (this.snapshots.size >= 24 || retainedRows + sessions.length > 200_000)) {
          const oldest = this.snapshots.keys().next().value!;
          retainedRows -= this.snapshots.get(oldest)!.sessions.length;
          this.snapshots.delete(oldest);
        }
        this.snapshots.set(id, { at: now, sessions });
      }
    }
    const end = Math.min(offset + limit, sessions.length);
    return {
      sessions: sessions.slice(offset, end),
      nextCursor: end < sessions.length ? `catalog:${id}:${end}` : null,
      scanning: this.refreshTask !== null,
      ...(this.partialFailure ? { partialFailure: true } : {}),
    };
  }
}
