import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage } from "node:http";
import { homedir } from "node:os";
import { basename, dirname, extname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  type CreateAgentSessionRuntimeFactory,
  createAgentSessionFromServices,
  createAgentSessionRuntime,
  createAgentSessionServices,
  getAgentDir,
  ModelRuntime,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import { WebSocketServer, type WebSocket } from "ws";
import QRCode from "qrcode";
import type {
  ClientCommand,
  ServerEvent,
  UICustomModelsResponse,
  UICustomProvider,
  UIExtensionInfo,
  UISessionInfo,
  UISnapshot,
  UIThinkingLevel,
} from "../shared/protocol.ts";
import { auth, authStartupInfo } from "./auth.ts";
import { readCustomModels, validateProviders, writeCustomModels } from "./models-config.ts";
import { serializeMessages } from "./serialize.ts";

const PORT = Number(process.env.PORT ?? 3141);
// Default to loopback — this server has no auth and can drive a coding agent.
// Override with HOST=0.0.0.0 only on trusted networks.
const HOST = process.env.HOST ?? "127.0.0.1";
const HOME = homedir();
// 개인 채팅 워크스페이스 (프로젝트 cwd와 분리). PI_WEB_CWD로 오버라이드 가능
const DEFAULT_AGENT_CWD = join(HOME, ".pi", "web-chat");
const AGENT_CWD = resolve(process.env.PI_WEB_CWD ?? DEFAULT_AGENT_CWD);
mkdirSync(AGENT_CWD, { recursive: true });

/** 데몬 상태 파일 디렉토리 (extensions/pi-web-chat.ts 의 STATE_DIR 과 동일) */
const DAEMON_STATE_DIR = join(HOME, ".pi", "web-chat");

// Resolve static assets for both layouts:
//   production package: <pkg>/dist/index.js  + <pkg>/dist/public/
//   dev (tsx server/):  <pkg>/server/index.ts + <pkg>/dist/  (vite default) or dist/public
const HERE = dirname(fileURLToPath(import.meta.url));

function readPackageVersion(): string {
  for (const candidate of [join(HERE, "..", "package.json"), join(HERE, "package.json")]) {
    try {
      if (!existsSync(candidate)) continue;
      const v = (JSON.parse(readFileSync(candidate, "utf8")) as { version?: string }).version;
      if (v) return v;
    } catch {
      /* ignore */
    }
  }
  return "unknown";
}
const PACKAGE_VERSION = readPackageVersion();
const DIST_DIR = (() => {
  const candidates = [
    join(HERE, "public"), // dist/index.js → dist/public
    join(HERE, "dist", "public"), // monorepo-style
    join(HERE, "..", "dist", "public"), // server/index.ts → dist/public
    join(HERE, "..", "dist"), // server/index.ts → dist (legacy vite outDir)
  ];
  for (const dir of candidates) {
    if (existsSync(join(dir, "index.html"))) return dir;
  }
  return candidates[0]!;
})();

// ---------------------------------------------------------------------------
// pi 세션 런타임
// ---------------------------------------------------------------------------

let modelRuntime = await ModelRuntime.create();

const createRuntime: CreateAgentSessionRuntimeFactory = async ({ cwd, sessionManager, sessionStartEvent }) => {
  const services = await createAgentSessionServices({ cwd });
  return {
    ...(await createAgentSessionFromServices({ services, sessionManager, sessionStartEvent })),
    services,
    diagnostics: services.diagnostics,
  };
};

// ---------------------------------------------------------------------------
// 세션 허브: 세션별로 독립된 런타임을 들고, 같은 세션을 보는 클라이언트끼리만
// 브로드캐스트한다. URL /s/:sessionId 와 1:1 대응.
// ---------------------------------------------------------------------------

interface SessionEntry {
  id: string;
  runtime: Awaited<ReturnType<typeof createAgentSessionRuntime>>;
  clients: Set<WebSocket>;
  unsubscribe?: () => void;
  lastActive: number;
  /**
   * URL(/s/:id)에 공개했는지.
   * `/` 접속으로 만든 빈 초안은 첫 prompt 전까지 false — 주소에 sessionId를 붙이지 않는다.
   */
  published: boolean;
  /** reload 중복 실행 방지 */
  reloading?: boolean;
}

const entries = new Map<string, SessionEntry>();
const pending = new Map<string, Promise<SessionEntry>>();
const wsEntry = new Map<WebSocket, SessionEntry>();
/** 비어 있는 세션 런타임을 정리하기 전 유예 시간 */
const IDLE_TTL_MS = 15 * 60_000;

/** 세션 파일명(<timestamp>_<uuid>.jsonl) → URL 식별자 */
function sessionIdOf(file?: string): string {
  if (!file) return "";
  const base = basename(file).replace(/\.jsonl$/, "");
  const i = base.lastIndexOf("_");
  return i >= 0 ? base.slice(i + 1) : base;
}

async function resolveSessionPath(id: string): Promise<string | undefined> {
  const sessions = await SessionManager.listAll();
  return sessions.find((s) => sessionIdOf(s.path) === id)?.path;
}

/**
 * 세션이 속한 프로젝트 디렉토리 (표시용): 세션 헤더의 cwd 우선,
 * 없으면 sessions/ 아래 부모 디렉토리 이름으로 폴백.
 */
function projectOf(s: { cwd?: string; path: string }): string {
  const cwd = s.cwd;
  if (cwd) {
    return cwd === HOME ? "~" : cwd.startsWith(HOME + "/") ? "~" + cwd.slice(HOME.length) : cwd;
  }
  return basename(dirname(s.path));
}

function broadcastTo(entry: SessionEntry, event: ServerEvent) {
  const data = JSON.stringify(event);
  for (const ws of entry.clients) {
    if (ws.readyState === ws.OPEN) ws.send(data);
  }
}

/** 세션을 URL에 공개 (idempotent). 첫 메시지·기존 세션 접속·포크 시 호출 */
function publishEntry(entry: SessionEntry, ws?: WebSocket) {
  entry.published = true;
  const event: ServerEvent = { type: "session_bound", sessionId: entry.id };
  if (ws) sendTo(ws, event);
  else broadcastTo(entry, event);
}

/** 세션이 교체되면(포크 등) 키를 다시 맞추고 클라이언트에 알린다 */
function rekeyEntry(entry: SessionEntry) {
  const next = sessionIdOf(entry.runtime.session.sessionFile);
  if (!next || next === entry.id) return;
  entries.delete(entry.id);
  entry.id = next;
  entries.set(next, entry);
  entry.published = true;
  broadcastTo(entry, { type: "session_bound", sessionId: next });
}

/** ~ 또는 ~/... 를 HOME 기반 절대경로로 확장 */
function expandHome(p: string): string {
  if (p === "~") return HOME;
  if (p.startsWith("~/")) return join(HOME, p.slice(2));
  return p;
}

async function createEntry(id: string | null, cwd?: string): Promise<SessionEntry> {
  const path = id ? await resolveSessionPath(id) : undefined;
  // 기존 세션 열기는 기존 동작 유지(AGENT_CWD), 새 세션만 cwd 파라미터 적용
  const sessionCwd = path ? AGENT_CWD : cwd ? expandHome(cwd) : AGENT_CWD;
  const runtime = await createAgentSessionRuntime(createRuntime, {
    cwd: sessionCwd,
    agentDir: getAgentDir(),
    sessionManager: SessionManager.create(sessionCwd),
  });
  if (path) await runtime.switchSession(path);
  const entry: SessionEntry = {
    id: sessionIdOf(runtime.session.sessionFile),
    runtime,
    clients: new Set(),
    lastActive: Date.now(),
    // 명시적 세션 id로 연 경우만 즉시 공개. null 접속은 빈 초안.
    published: id !== null,
  };
  entries.set(entry.id, entry);
  bindSession(entry);
  return entry;
}

/** id가 없으면 새 세션, 있으면 기존 런타임 재사용 (동시 접속 경합 방지) */
async function acquireEntry(id: string | null, cwd?: string): Promise<SessionEntry> {
  if (!id) return createEntry(null, cwd);
  const hit = entries.get(id);
  if (hit) return hit;
  const inflight = pending.get(id);
  if (inflight) return inflight;
  const p = createEntry(id).finally(() => pending.delete(id));
  pending.set(id, p);
  return p;
}

/** 비어 있고 오래된 런타임 정리 */
setInterval(() => {
  const now = Date.now();
  for (const entry of [...entries.values()]) {
    if (entry.clients.size > 0 || entry.runtime.session.isStreaming) continue;
    if (now - entry.lastActive < IDLE_TTL_MS) continue;
    entries.delete(entry.id);
    entry.unsubscribe?.();
    void entry.runtime.dispose().catch(() => {});
  }
}, 60_000).unref();

/**
 * 세션 파일이 외부(터미널의 pi 프로세스 등)에서 추가되면 런타임을 재로드해 뷰를 최신화.
 * 스트리밍 중에는 건드리지 않는다 (자신의 prompt 응답을 보호).
 */
async function reloadEntry(entry: SessionEntry): Promise<void> {
  if (entry.reloading) return;
  entry.reloading = true;
  try {
    const file = entry.runtime.session.sessionFile;
    if (!file) return;
    entry.unsubscribe?.();
    try {
      await entry.runtime.dispose();
    } catch {
      /* ignore */
    }
    const runtime = await createAgentSessionRuntime(createRuntime, {
      cwd: AGENT_CWD,
      agentDir: getAgentDir(),
      sessionManager: SessionManager.create(AGENT_CWD),
    });
    await runtime.switchSession(file);
    entry.runtime = runtime;
    bindSession(entry);
    broadcastSnapshot(entry);
  } finally {
    entry.reloading = false;
  }
}

/** 파일의 실제 entry 수 (빈 줄 제외) */
function countFileEntries(file: string): number {
  const content = readFileSync(file, "utf8");
  let count = 0;
  for (const line of content.split("\n")) {
    if (line.trim().length > 0) count++;
  }
  return count;
}

setInterval(() => {
  for (const entry of [...entries.values()]) {
    if (entry.clients.size === 0) continue;
    const file = entry.runtime.session.sessionFile;
    if (!file || entry.reloading || entry.runtime.session.isStreaming) continue;
    let fileEntries = 0;
    try {
      fileEntries = countFileEntries(file);
    } catch {
      continue; // 파일이 아직 생성 안 됨 (빈 초안)
    }
    // 헤더(1) + 런타임 메모리 엔트리 수 보다 파일이 더 많으면 외부 추가 → 재로드
    const memoryEntries = entry.runtime.session.sessionManager.getEntries().length + 1;
    if (fileEntries > memoryEntries) {
      void reloadEntry(entry).catch(() => {});
    }
  }
}, 1500).unref();

const ALL_THINKING_LEVELS: UIThinkingLevel[] = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
];

function supportedThinkingLevels(model: unknown): UIThinkingLevel[] {
  const m = model as
    | { reasoning?: boolean; thinkingLevelMap?: Record<string, string | null> }
    | null
    | undefined;
  if (!m?.reasoning) return ["off"];
  const map = m.thinkingLevelMap;
  return ALL_THINKING_LEVELS.filter((level) => {
    if (map && map[level] === null) return false;
    // xhigh/max는 명시적으로 매핑된 모델 패밀리만 지원
    if ((level === "xhigh" || level === "max") && map?.[level] == null) return false;
    return true;
  });
}

function buildSnapshot(entry: SessionEntry): UISnapshot {
  const session = entry.runtime.session;
  const model = session.model;
  return {
    messages: serializeMessages(session.messages),
    isStreaming: session.isStreaming,
    model: model
      ? {
          provider: model.provider,
          id: model.id,
          name: (model as { name?: string }).name,
          reasoning: (model as { reasoning?: boolean }).reasoning,
        }
      : null,
    thinkingLevel: session.thinkingLevel as UIThinkingLevel,
    thinkingLevels: supportedThinkingLevels(model),
    context: session.getContextUsage() ?? null,
    sessionFile: session.sessionFile,
    sessionId: entry.id,
  };
}

function broadcastSnapshot(entry: SessionEntry) {
  broadcastTo(entry, { type: "snapshot", snapshot: buildSnapshot(entry) });
}

/** 세션 이벤트 구독 (세션 교체 시 재구독 필요) */
function bindSession(entry: SessionEntry) {
  entry.unsubscribe?.();
  entry.unsubscribe = entry.runtime.session.subscribe((event) => {
    entry.lastActive = Date.now();
    const broadcast = (e: ServerEvent) => broadcastTo(entry, e);
    switch (event.type) {
      case "message_update": {
        const e = event.assistantMessageEvent;
        if (e.type === "text_delta") {
          broadcast({ type: "delta", kind: "text", delta: e.delta });
        } else if (e.type === "thinking_delta") {
          broadcast({ type: "delta", kind: "thinking", delta: e.delta });
        }
        break;
      }
      case "message_end":
        broadcastSnapshot(entry);
        break;
      case "tool_execution_start":
        broadcast({ type: "tool_start", toolCallId: event.toolCallId, toolName: event.toolName });
        break;
      case "tool_execution_end":
        broadcast({
          type: "tool_end",
          toolCallId: event.toolCallId,
          toolName: event.toolName,
          isError: event.isError,
        });
        broadcastSnapshot(entry);
        break;
      case "agent_start":
        broadcast({ type: "agent_start" });
        break;
      case "agent_end": {
        broadcast({ type: "agent_end" });
        // agent_end 직후 session.isStreaming 이 아직 true일 수 있어 명시적으로 false
        const snap = buildSnapshot(entry);
        snap.isStreaming = false;
        broadcast({ type: "snapshot", snapshot: snap });
        break;
      }
    }
  });
}

// ---------------------------------------------------------------------------
// 클라이언트 커맨드 처리
// ---------------------------------------------------------------------------

async function handleCommand(cmd: ClientCommand, ws: WebSocket) {
  const entry = wsEntry.get(ws);
  if (!entry) return;
  entry.lastActive = Date.now();
  const runtime = entry.runtime;
  const session = runtime.session;
  switch (cmd.type) {
    case "prompt": {
      const text = cmd.text.trim();
      const images = (cmd.images ?? []).map((img) => ({
        type: "image" as const,
        data: img.data,
        mimeType: img.mimeType,
      }));
      if (!text && images.length === 0) return;
      // 첫 입력 시점에 세션을 URL에 공개 → 클라이언트가 /s/:id 로 교체
      if (!entry.published) publishEntry(entry, ws);
      // prompt()는 전체 런이 끝날 때까지 resolve되지 않으므로 await하지 않는다
      session
        .prompt(text, {
          images: images.length > 0 ? images : undefined,
          ...(session.isStreaming ? { streamingBehavior: "steer" as const } : {}),
        })
        .catch((err) => {
          sendTo(ws, { type: "error", message: String(err instanceof Error ? err.message : err) });
        });
      break;
    }
    case "abort":
      await session.abort();
      broadcastSnapshot(entry);
      break;
    case "set_model": {
      const model = modelRuntime.getModel(cmd.provider, cmd.id);
      if (!model) {
        sendTo(ws, { type: "error", message: `Model not found: ${cmd.provider}/${cmd.id}` });
        return;
      }
      await runtime.session.setModel(model);
      broadcastSnapshot(entry);
      break;
    }
    case "set_thinking_level":
      session.setThinkingLevel(cmd.level);
      broadcastSnapshot(entry);
      break;
    case "fork": {
      const result = await runtime.fork(cmd.entryId);
      if (result.cancelled) return;
      bindSession(entry);
      rekeyEntry(entry);
      broadcastSnapshot(entry);
      sendTo(ws, { type: "forked", selectedText: result.selectedText });
      break;
    }
  }
}

function sendTo(ws: WebSocket, event: ServerEvent) {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(event));
}

/**
 * 세션 파일 삭제. 로드된 런타임이 있으면 정리하고, 접속 중인 클라이언트를 닫는다.
 * 세션은 append-only JSONL 파일이므로 SDK 삭제 API 대신 파일 제거로 처리한다.
 */
async function deleteSession(id: string): Promise<{ ok: boolean; error?: string }> {
  const path = await resolveSessionPath(id);
  if (!path) return { ok: false, error: "session not found" };

  const entry = entries.get(id);
  if (entry) {
    entry.unsubscribe?.();
    for (const ws of [...entry.clients]) {
      try {
        ws.close(1000, "session deleted");
      } catch {
        /* ignore */
      }
    }
    entry.clients.clear();
    entries.delete(id);
    try {
      await entry.runtime.dispose();
    } catch {
      /* ignore */
    }
  }

  try {
    unlinkSync(path);
  } catch (err) {
    return { ok: false, error: `failed to delete file: ${String(err)}` };
  }
  return { ok: true };
}

/** 세션 표시 이름 변경 (비어 있으면 이름 해제). */
async function renameSession(
  id: string,
  name: string,
): Promise<{ ok: boolean; error?: string; name?: string }> {
  const path = await resolveSessionPath(id);
  if (!path) return { ok: false, error: "session not found" };

  const entry = entries.get(id);
  if (entry) {
    // 로드된 런타임: setSessionName → appendSessionInfo(파일에 즉시 영속화) + 이벤트 방출
    entry.runtime.session.setSessionName(name);
    broadcastSnapshot(entry);
  } else {
    try {
      const sm = SessionManager.open(path);
      sm.appendSessionInfo(name);
    } catch (err) {
      return { ok: false, error: `failed to rename: ${String(err)}` };
    }
  }
  return { ok: true, name };
}

// ---------------------------------------------------------------------------
// 커스텀 모델 (models.json) 반영
// ---------------------------------------------------------------------------

function readBody(req: IncomingMessage, limit = 1_000_000): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > limit) {
        reject(new Error("request body too large"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

/**
 * 저장된 providers 를 실행 중인 런타임에 반영한다.
 * - 목록용 modelRuntime 은 재생성 (models.json 을 다시 읽음)
 * - 대화 중인 세션 런타임에는 registerProvider 로 라이브 등록
 * 실패하면 재시작이 필요하다는 경고 문자열을 돌려준다.
 */
async function reloadModelProviders(providers: UICustomProvider[]): Promise<string | undefined> {
  const previousKeys = new Set(knownCustomProviderKeys);
  knownCustomProviderKeys = new Set(providers.map((p) => p.key));

  try {
    modelRuntime = await ModelRuntime.create();
  } catch (err) {
    return `models.json saved, but reloading failed: ${String(err)}`;
  }

  try {
    for (const entry of entries.values()) {
      const sessionModels = entry.runtime.services.modelRuntime;
      for (const key of previousKeys) {
        if (!knownCustomProviderKeys.has(key)) sessionModels.unregisterProvider(key);
      }
      for (const p of providers) {
        sessionModels.registerProvider(p.key, {
          baseUrl: p.baseUrl,
          apiKey: p.apiKey,
          api: p.api,
          models: p.models.map((m) => ({
            id: m.id,
            name: m.name ?? m.id,
            reasoning: m.reasoning ?? false,
            input: m.input && m.input.length > 0 ? m.input : ["text"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: m.contextWindow ?? 128_000,
            maxTokens: m.maxTokens ?? 8_192,
          })),
        });
      }
    }
  } catch (err) {
    return `models.json saved, but live reload failed (restart pi --web to apply): ${
      err instanceof Error ? err.message : String(err)
    }`;
  }
  return undefined;
}

let knownCustomProviderKeys = new Set(readCustomModels().providers.map((p) => p.key));

// ---------------------------------------------------------------------------
// HTTP 서버 (API + 정적 파일)
// ---------------------------------------------------------------------------

const MIME: Record<string, string> = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".css": "text/css",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".webmanifest": "application/manifest+json",
};

/** Authorization: Bearer <t> 또는 ?token=<t> 에서 세션 토큰 추출 */
function sessionTokenFromRequest(req: IncomingMessage): string {
  const header = req.headers.authorization;
  if (header?.startsWith("Bearer ")) return header.slice("Bearer ".length).trim();
  try {
    return new URL(req.url ?? "/", "http://localhost").searchParams.get("token") ?? "";
  } catch {
    return "";
  }
}

async function handleAuthRequest(req: IncomingMessage, res: import("node:http").ServerResponse, url: URL) {
  const sendJson = (status: number, body: unknown) => {
    res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
    res.end(JSON.stringify(body));
  };

  // 로그인 상태 확인
  if (url.pathname === "/api/auth/status") {
    if (!auth.validSession(sessionTokenFromRequest(req))) {
      sendJson(401, { ok: false, twoFactor: auth.twoFactorEnabled });
      return;
    }
    sendJson(200, { ok: true, twoFactor: auth.twoFactorEnabled });
    return;
  }

  // 로그인 (토큰 + 2FA 코드)
  if (url.pathname === "/api/auth/login" && req.method === "POST") {
    let body: { token?: unknown; totp?: unknown };
    try {
      body = JSON.parse(await readBody(req, 10_000)) as { token?: unknown; totp?: unknown };
    } catch {
      sendJson(400, { error: "invalid JSON body" });
      return;
    }
    const token = typeof body.token === "string" ? body.token : "";
    const totp = typeof body.totp === "string" ? body.totp : undefined;
    const result = auth.login(token, totp);
    if (!result.sessionToken) {
      sendJson(401, {
        error: result.reason === "2fa" ? "invalid 2FA code" : "invalid access token",
      });
      return;
    }
    sendJson(200, { sessionToken: result.sessionToken });
    return;
  }

  // 로그아웃
  if (url.pathname === "/api/auth/logout" && req.method === "POST") {
    auth.logout(sessionTokenFromRequest(req));
    sendJson(200, { ok: true });
    return;
  }

  // 2FA 시크릿/QR 재조회 — 원시 토큰 필요 (로컬에서 인증 앱 등록용)
  if (url.pathname === "/api/auth/setup" && req.method === "GET") {
    const rawToken = url.searchParams.get("token") ?? "";
    if (!auth.verifyRawToken(rawToken)) {
      sendJson(401, { error: "invalid token" });
      return;
    }
    const otpauth = auth.otpauthUrl();
    let qr = "";
    try {
      qr = await QRCode.toDataURL(otpauth, { width: 220, margin: 1 });
    } catch {
      /* QR 생성 실패해도 otpauth URL은 반환 */
    }
    sendJson(200, {
      twoFactorEnabled: auth.twoFactorEnabled,
      secret: auth.totpSecret,
      otpauthUrl: otpauth,
      qr,
    });
    return;
  }

  sendJson(404, { error: "not found" });
}


const httpServer = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://localhost");

  try {
    // Lightweight readiness probe (used by `pi --web` before opening the browser).
    if (url.pathname === "/api/health") {
      res.writeHead(200, {
        "content-type": "application/json",
        "cache-control": "no-store",
      });
      res.end(JSON.stringify({ ok: true, version: PACKAGE_VERSION }));
      return;
    }

    // 인증 API (세션 없이 접근 가능)
    if (url.pathname.startsWith("/api/auth/")) {
      await handleAuthRequest(req, res, url);
      return;
    }

    // 그 외 모든 API는 세션 토큰 필수 (정적 파일/폰트는 로그인 화면 로딩을 위해 열어둠)
    if (url.pathname.startsWith("/api/") && !auth.validSession(sessionTokenFromRequest(req))) {
      res.writeHead(401, {
        "content-type": "application/json",
        "cache-control": "no-store",
      });
      res.end(JSON.stringify({ error: "unauthorized" }));
      return;
    }

    if (url.pathname === "/api/sessions") {
      const sessions = await SessionManager.listAll();
      const list: UISessionInfo[] = sessions
        .sort((a, b) => b.modified.getTime() - a.modified.getTime())
        .slice(0, 300)
        .map((s) => ({
          id: sessionIdOf(s.path),
          path: s.path,
          project: projectOf(s),
          name: s.name,
          firstMessage: s.firstMessage.slice(0, 200),
          modified: s.modified.toISOString(),
          messageCount: s.messageCount,
        }));
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(list));
      return;
    }

    // 세션 삭제 / 이름 변경
    if (url.pathname.startsWith("/api/sessions/")) {
      const id = decodeURIComponent(url.pathname.slice("/api/sessions/".length));
      if (!id) {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "missing session id" }));
        return;
      }

      if (req.method === "DELETE") {
        const result = await deleteSession(id);
        res.writeHead(result.ok ? 200 : 404, { "content-type": "application/json" });
        res.end(JSON.stringify(result.ok ? { ok: true } : { error: result.error }));
        return;
      }

      if (req.method === "POST" && url.pathname.endsWith("/name")) {
        const sessionId = decodeURIComponent(
          url.pathname.slice("/api/sessions/".length, -"/name".length),
        );
        if (!sessionId) {
          res.writeHead(400, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: "missing session id" }));
          return;
        }
        const body = await readBody(req, 10_000);
        let name = "";
        try {
          name = String((JSON.parse(body) as { name?: unknown }).name ?? "").trim();
        } catch {
          res.writeHead(400, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: "invalid JSON body" }));
          return;
        }
        const result = await renameSession(sessionId, name);
        res.writeHead(result.ok ? 200 : 404, { "content-type": "application/json" });
        res.end(JSON.stringify(result.ok ? { ok: true, name: result.name } : { error: result.error }));
        return;
      }

      res.writeHead(405, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "method not allowed" }));
      return;
    }

    if (url.pathname === "/api/models") {
      const models = await modelRuntime.getAvailable();
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify(
          models.map((m) => ({
            provider: m.provider,
            id: m.id,
            name: (m as { name?: string }).name,
            reasoning: (m as { reasoning?: boolean }).reasoning,
          })),
        ),
      );
      return;
    }

    // 커스텀 모델 관리 (~/.pi/agent/models.json)
    if (url.pathname === "/api/custom-models") {
      if (req.method === "GET") {
        res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
        res.end(JSON.stringify(readCustomModels()));
        return;
      }
      if (req.method === "PUT") {
        const body = await readBody(req);
        let providers: UICustomProvider[];
        try {
          providers = (JSON.parse(body) as { providers: UICustomProvider[] }).providers;
        } catch (err) {
          res.writeHead(400, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: `invalid JSON: ${String(err)}` }));
          return;
        }
        const invalid = validateProviders(providers);
        if (invalid) {
          res.writeHead(400, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: invalid }));
          return;
        }
        writeCustomModels(providers);
        const warning = await reloadModelProviders(providers);
        const result: UICustomModelsResponse = { ...readCustomModels(), warning };
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(result));
        return;
      }
      res.writeHead(405, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "method not allowed" }));
      return;
    }

    if (url.pathname === "/api/fork-points") {
      const entry = entries.get(url.searchParams.get("session") ?? "");
      if (!entry) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end("[]");
        return;
      }
      const points = entry.runtime.session.getUserMessagesForForking();
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify(points.map((p) => ({ entryId: p.entryId, text: p.text.slice(0, 200) }))),
      );
      return;
    }

    if (url.pathname === "/api/extensions") {
      const anyEntry = entries.values().next().value as SessionEntry | undefined;
      if (!anyEntry) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ extensions: [], errors: [] }));
        return;
      }
      const { extensions, errors } = anyEntry.runtime.session.resourceLoader.getExtensions();
      const shorten = (p: string) => (p.startsWith(HOME) ? `~${p.slice(HOME.length)}` : p);
      const list: UIExtensionInfo[] = extensions.map((ext) => {
        const { sourceInfo } = ext;
        let name: string;
        let packageName: string | undefined;
        if (sourceInfo.origin === "package") {
          packageName = sourceInfo.source.replace(/^npm:/, "");
          // 패키지 루트 기준 상대경로에서 표시명 유도 (extensions/foo/index.ts -> foo)
          const rel = relative(sourceInfo.baseDir ?? dirname(ext.path), ext.path)
            .replace(/\.(ts|js|mjs|cjs)$/, "")
            .replace(/\/index$/, "")
            .replace(/^index$/, "")
            .replace(/^(src\/)?(extensions\/)?/, "");
          name = rel && rel !== "src" ? rel : packageName;
        } else {
          name = basename(ext.path).replace(/\.(ts|js|mjs|cjs)$/, "");
        }
        return {
          name,
          packageName,
          path: shorten(ext.path),
          scope: sourceInfo.scope,
          tools: [...ext.tools.keys()],
          commands: [...ext.commands.keys()],
          flags: [...ext.flags.keys()],
          events: [...ext.handlers.keys()],
        };
      });
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          extensions: list,
          errors: errors.map((e) => ({ path: shorten(e.path), error: e.error })),
        }),
      );
      return;
    }

    if (url.pathname === "/api/state") {
      const requested = url.searchParams.get("session");
      const entry = requested ? entries.get(requested) : undefined;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify(
          entry
            ? buildSnapshot(entry)
            : {
                activeSessions: [...entries.values()].map((e) => ({
                  id: e.id,
                  clients: e.clients.size,
                  isStreaming: e.runtime.session.isStreaming,
                })),
              },
        ),
      );
      return;
    }

    // 정적 파일 (프로덕션 빌드)
    if (existsSync(DIST_DIR)) {
      let filePath = join(DIST_DIR, url.pathname === "/" ? "index.html" : url.pathname);
      if (!filePath.startsWith(DIST_DIR) || !existsSync(filePath)) {
        filePath = join(DIST_DIR, "index.html"); // SPA fallback
      }
      const ext = extname(filePath);
      res.writeHead(200, { "content-type": MIME[ext] ?? "application/octet-stream" });
      res.end(readFileSync(filePath));
      return;
    }

    res.writeHead(404);
    res.end("Not found. Run `npm run build` first, or use `npm run dev`.");
  } catch (err) {
    res.writeHead(500, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: String(err instanceof Error ? err.message : err) }));
  }
});

const wss = new WebSocketServer({ noServer: true });

// WS 핸드셰이크에서 세션 토큰 검증 (?token=)
httpServer.on("upgrade", (req, socket, head) => {
  const url = new URL(req.url ?? "/", "http://localhost");
  if (url.pathname !== "/ws") {
    socket.destroy();
    return;
  }
  const token = url.searchParams.get("token") ?? "";
  if (!auth.validSession(token)) {
    socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
});

wss.on("connection", (ws, req) => {
  const query = new URL(req.url ?? "/ws", "http://localhost").searchParams;
  const requested = query.get("session");
  const cwd = query.get("cwd") ?? undefined;
  const queue: ClientCommand[] = [];
  let ready = false;

  ws.on("message", (raw) => {
    let cmd: ClientCommand;
    try {
      cmd = JSON.parse(raw.toString());
    } catch {
      return;
    }
    // 세션 바인딩 완료 전에 도착한 커맨드는 잠시 보관
    if (!ready) {
      queue.push(cmd);
      return;
    }
    handleCommand(cmd, ws).catch((err) => {
      sendTo(ws, { type: "error", message: String(err instanceof Error ? err.message : err) });
    });
  });

  acquireEntry(requested, cwd)
    .then((entry) => {
      if (ws.readyState !== ws.OPEN) return;
      entry.clients.add(ws);
      entry.lastActive = Date.now();
      wsEntry.set(ws, entry);
      // 기존 세션(/s/:id) 또는 이미 공개된 세션만 즉시 바인딩.
      // `/` 빈 초안은 첫 prompt 때 session_bound → URL 정리.
      if (entry.published || requested) {
        publishEntry(entry, ws);
      }
      sendTo(ws, { type: "hello", version: PACKAGE_VERSION });
      sendTo(ws, { type: "snapshot", snapshot: buildSnapshot(entry) });
      ready = true;
      for (const cmd of queue.splice(0)) {
        handleCommand(cmd, ws).catch((err) => {
          sendTo(ws, { type: "error", message: String(err instanceof Error ? err.message : err) });
        });
      }
    })
    .catch((err) => {
      sendTo(ws, { type: "error", message: String(err instanceof Error ? err.message : err) });
      ws.close();
    });

  ws.on("close", () => {
    const entry = wsEntry.get(ws);
    if (entry) {
      entry.clients.delete(ws);
      entry.lastActive = Date.now();
      wsEntry.delete(ws);
    }
  });
});

// 바인딩 실패(포트 점유 등)를 크래시 스택 대신 명확한 메시지로 처리.
// 확장(startServer)이 스폰 직후에 pid 파일을 썼다면 이 서버는 죽기 때문에
// readPid() 의 프로세스 살아있음 검사가 걸러낸다. 여기서는 사용자에게 안내만 한다.
httpServer.on("error", (err: NodeJS.ErrnoException) => {
  if (err.code === "EADDRINUSE") {
    console.error(
      `pi-web-chat: port ${PORT} is already in use — another pi-web-chat server or process is listening.`,
    );
    console.error(
      `pi-web-chat: run \`pi --web status\` / \`pi --web stop\`, or remove stale ~/.pi/web-chat/pi-web-chat.pid, then retry.`,
    );
    process.exit(1);
  }
  throw err;
});

httpServer.listen(PORT, HOST, () => {
  const displayHost = HOST === "0.0.0.0" || HOST === "::" ? "localhost" : HOST;
  console.log(
    `pi-web-chat server: http://${displayHost}:${PORT}  (bind ${HOST}, chat cwd: ${AGENT_CWD})`,
  );

  // 확장이 스폰 직후 쓰는 pid/port/host 를 여기서(바인딩 성공 후) 덮어쓴다.
  // → 포트 점유로 죽은 프로세스의 pid 가 남는 경쟁 상태를 없앤다.
  try {
    mkdirSync(DAEMON_STATE_DIR, { recursive: true });
    writeFileSync(join(DAEMON_STATE_DIR, "pi-web-chat.pid"), `${process.pid}\n`, "utf8");
    writeFileSync(join(DAEMON_STATE_DIR, "pi-web-chat.port"), `${PORT}\n`, "utf8");
    writeFileSync(join(DAEMON_STATE_DIR, "pi-web-chat.host"), `${HOST}\n`, "utf8");
  } catch {
    /* 상태 파일은 부가 정보 — 실패해도 서버는 동작 */
  }
  if (auth.twoFactorEnabled) {
    console.log(`pi-web-chat auth: access token = ${auth.token}  (file: ${authStartupInfo().tokenFile})`);
    console.log(`pi-web-chat auth: 2FA(TOTP) enabled — secret: ${authStartupInfo().secretFile}`);
    console.log(
      `pi-web-chat auth: login needs the token + a 2FA code from your authenticator app`,
    );
  } else {
    console.log(`pi-web-chat auth: 2FA disabled (PI_WEB_2FA=off), access token = ${auth.token}`);
  }
});

// 재시작 시 세션(로그인 상태)을 디스크로 플러시
process.on("SIGTERM", () => {
  auth.flushSessions();
});
process.on("SIGINT", () => {
  auth.flushSessions();
});
