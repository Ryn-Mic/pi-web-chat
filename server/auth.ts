/**
 * pi-web-chat 인증 모듈
 *
 * - 액세스 토큰: PI_WEB_TOKEN env 또는 자동 생성 (~/.pi/web-chat/token, 32바이트 hex)
 * - 2FA: TOTP (RFC 6238, SHA-1, 30s, 6자리) — PI_WEB_2FA=off 로 끌 수 있음 (기본 켜짐)
 *   시크릿은 ~/.pi/web-chat/2fa.secret (base32) 에 로컬 저장.
 * - 로그인 성공 시 메모리 세션 토큰 발급 (30일 슬라이딩 만료).
 *   모든 API/WS 요청은 세션 토큰으로 검증한다.
 *
 * 외부 의존성 없음 (node:crypto). QR 코드 생성을 위해선 qrcode 패키지를 사용하지만
 * 이 모듈은 코드 생성/검증만 담당한다.
 */
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const STATE_DIR = join(homedir(), ".pi", "web-chat");
const TOKEN_FILE = join(STATE_DIR, "token");
const SECRET_FILE = join(STATE_DIR, "2fa.secret");
const SESSIONS_FILE = join(STATE_DIR, "sessions.json");

const TWO_FACTOR_ENABLED = process.env.PI_WEB_2FA !== "off";
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30일
const SESSION_CLEANUP_MS = 10 * 60 * 1000;
const SESSIONS_SAVE_DEBOUNCE_MS = 500;

const BASE32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

function base32Encode(buf: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32[(value >>> (bits - 5)) & 31]!;
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32[(value << (5 - bits)) & 31]!;
  return out;
}

function base32Decode(input: string): Buffer {
  const clean = input.toUpperCase().replace(/[^A-Z2-7]/g, "");
  let bits = 0;
  let value = 0;
  const bytes: number[] = [];
  for (const ch of clean) {
    const idx = BASE32.indexOf(ch);
    if (idx < 0) continue;
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(bytes);
}

function readOrCreate(file: string, generate: () => string): string {
  try {
    if (existsSync(file)) {
      const existing = readFileSync(file, "utf8").trim();
      if (existing) return existing;
    }
  } catch {
    /* ignore */
  }
  const value = generate();
  try {
    writeFileSync(file, value + "\n", { mode: 0o600 });
  } catch {
    /* ignore — 로그로만 안내 */
  }
  return value;
}

/** SHA-256 해시 후 상수시간 비교 (길이 불일치 회피) */
function safeEqual(a: string, b: string): boolean {
  const ha = createHash("sha256").update(a).digest();
  const hb = createHash("sha256").update(b).digest();
  return timingSafeEqual(ha, hb);
}

// ---------------------------------------------------------------------------
// TOTP (RFC 6238)
// ---------------------------------------------------------------------------

function generateSecret(): string {
  return base32Encode(randomBytes(20)); // 160-bit
}

/** 현재 시간 기준 TOTP 코드 (period=30s, digits=6) */
function totpAt(secret: string, atSeconds: number, period = 30, digits = 6): string {
  const key = base32Decode(secret);
  const counter = Math.floor(atSeconds / period);
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const hmac = createHmac("sha1", key).update(msg).digest();
  const offset = hmac[hmac.length - 1]! & 0x0f;
  const bin =
    ((hmac[offset]! & 0x7f) << 24) |
    (hmac[offset + 1]! << 16) |
    (hmac[offset + 2]! << 8) |
    hmac[offset + 3]!;
  return String(bin % 10 ** digits).padStart(digits, "0");
}

function otpauthUrl(secret: string, label = "pi-web-chat"): string {
  return `otpauth://totp/${encodeURIComponent(label)}?secret=${secret}&issuer=${encodeURIComponent(label)}&algorithm=SHA1&digits=6&period=30`;
}

function verifyTotp(secret: string, code: string): boolean {
  const clean = code.trim().replace(/\s/g, "");
  if (!/^\d{6}$/.test(clean)) return false;
  const now = Math.floor(Date.now() / 1000);
  // ±1 윈도우 허용 (시계 오차)
  for (const offset of [0, -1, 1]) {
    if (safeEqual(totpAt(secret, now + offset * 30), clean)) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// 세션 토큰 저장소 (메모리)
// ---------------------------------------------------------------------------

interface Session {
  createdAt: number;
  lastUsed: number;
}

class Auth {
  readonly token: string;
  readonly twoFactorEnabled: boolean;
  readonly totpSecret: string;
  private readonly sessions = new Map<string, Session>();
  private saveTimer: ReturnType<typeof setTimeout> | null = null;

  constructor() {
    this.token = this.readToken();
    this.twoFactorEnabled = TWO_FACTOR_ENABLED;
    this.totpSecret = readOrCreate(SECRET_FILE, generateSecret);
    this.loadSessions();
    setInterval(() => this.cleanupSessions(), SESSION_CLEANUP_MS).unref();
  }

  /** 재시작 후에도 로그인 유지: 세션 토큰을 디스크에 영속 */
  private loadSessions(): void {
    try {
      if (!existsSync(SESSIONS_FILE)) return;
      const raw = JSON.parse(readFileSync(SESSIONS_FILE, "utf8")) as Record<
        string,
        { createdAt?: number; lastUsed?: number }
      >;
      const now = Date.now();
      for (const [token, s] of Object.entries(raw)) {
        if (!s || now - (s.lastUsed ?? 0) > SESSION_TTL_MS) continue;
        this.sessions.set(token, {
          createdAt: s.createdAt ?? now,
          lastUsed: s.lastUsed ?? now,
        });
      }
    } catch {
      /* ignore — 저장된 세션 없음 */
    }
  }

  private scheduleSave(): void {
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      this.saveNow();
    }, SESSIONS_SAVE_DEBOUNCE_MS);
    this.saveTimer.unref?.();
  }

  /** 동기 저장 (로그인/로그아웃/종료 시) */
  private saveNow(): void {
    try {
      writeFileSync(SESSIONS_FILE, JSON.stringify(Object.fromEntries(this.sessions)), {
        mode: 0o600,
      });
    } catch {
      /* ignore */
    }
  }

  /** SIGTERM 등 종료 시 남은 변경분을 즉시 기록 */
  flushSessions(): void {
    this.saveNow();
  }

  /**
   * 현재 유효한 액세스 토큰: 파일이 우선(첫 시작 시 env 또는 자동 생성으로 파일에 기록).
   * 로그인마다 파일을 다시 읽어 `rftoken` 으로 교체한 토큰이 재시작 없이 바로 적용된다.
   */
  private readToken(): string {
    try {
      const fromFile = readFileSync(TOKEN_FILE, "utf8").trim();
      if (fromFile) return fromFile;
    } catch {
      /* ignore */
    }
    const envToken = process.env.PI_WEB_TOKEN?.trim();
    if (envToken) {
      try {
        writeFileSync(TOKEN_FILE, envToken + "\n", { mode: 0o600 });
      } catch {
        /* ignore */
      }
      return envToken;
    }
    const generated = randomBytes(32).toString("hex");
    try {
      writeFileSync(TOKEN_FILE, generated + "\n", { mode: 0o600 });
    } catch {
      /* ignore */
    }
    return generated;
  }

  /** 로그인: 토큰 + (2FA 켜짐이면) TOTP 코드 검증 → 세션 토큰 발급 */
  login(
    rawToken: string,
    totpCode?: string,
  ): { sessionToken?: string; reason?: "token" | "2fa" } {
    if (!safeEqual(this.readToken(), rawToken.trim())) return { reason: "token" };
    if (this.twoFactorEnabled && !verifyTotp(this.totpSecret, totpCode ?? "")) {
      return { reason: "2fa" };
    }
    const sessionToken = randomBytes(32).toString("hex");
    this.sessions.set(sessionToken, { createdAt: Date.now(), lastUsed: Date.now() });
    this.saveNow();
    return { sessionToken };
  }

  /** 원시 액세스 토큰 검증 (예: /api/auth/setup QR 재조회용) */
  verifyRawToken(rawToken: string): boolean {
    return safeEqual(this.readToken(), rawToken.trim());
  }

  validSession(sessionToken: string): boolean {
    if (!sessionToken) return false;
    const s = this.sessions.get(sessionToken);
    if (!s) return false;
    s.lastUsed = Date.now();
    this.scheduleSave();
    return true;
  }

  logout(sessionToken: string): void {
    this.sessions.delete(sessionToken);
    this.saveNow();
  }

  private cleanupSessions(): void {
    const now = Date.now();
    let changed = false;
    for (const [token, s] of this.sessions) {
      if (now - s.lastUsed > SESSION_TTL_MS) {
        this.sessions.delete(token);
        changed = true;
      }
    }
    if (changed) this.scheduleSave();
  }

  /** 최근 2FA 코드 (지역/콘솔 안내용). 인증 앱 대신 여기서 읽어 로그인할 수 있다. */
  currentTotp(): string {
    return totpAt(this.totpSecret, Math.floor(Date.now() / 1000));
  }

  otpauthUrl(): string {
    return otpauthUrl(this.totpSecret);
  }
}

export const auth = new Auth();

/** 스타트업 로그에 출력할 인증 정보 (token 미리보기 제외) */
export function authStartupInfo(): { twoFactorEnabled: boolean; hasToken: boolean; tokenFile: string; secretFile: string } {
  return {
    twoFactorEnabled: auth.twoFactorEnabled,
    hasToken: auth.token.length > 0,
    tokenFile: TOKEN_FILE,
    secretFile: SECRET_FILE,
  };
}

export { verifyTotp, otpauthUrl };
