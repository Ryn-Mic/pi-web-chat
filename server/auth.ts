/**
 * pi-web-chat auth module
 *
 * - Access token: PI_WEB_TOKEN env or auto-generated (~/.pi/web-chat/token, 32-byte hex)
 * - 2FA: TOTP (RFC 6238, SHA-1, 30s, 6 digits) — can be disabled with PI_WEB_2FA=off (on by default)
 *   Secret is stored locally at ~/.pi/web-chat/2fa.secret (base32).
 * - A successful login issues an in-memory session token (30-day sliding expiry).
 *   Every API/WS request is verified against the session token.
 *
 * No external dependencies (node:crypto). The qrcode package is used for QR
 * generation, but this module only creates/verifies codes.
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
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
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
    /* ignore — log-only */
  }
  return value;
}

/** SHA-256 hash then constant-time compare (avoids length mismatch) */
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

/** TOTP code for the current time (period=30s, digits=6) */
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
  // Allow ±1 window (clock drift)
  for (const offset of [0, -1, 1]) {
    if (safeEqual(totpAt(secret, now + offset * 30), clean)) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Session token store (in memory)
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

  /** Keep logins after restart: persist session tokens to disk */
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
      /* ignore — no saved sessions */
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

  /** Synchronous save (on login/logout/shutdown) */
  private saveNow(): void {
    try {
      writeFileSync(SESSIONS_FILE, JSON.stringify(Object.fromEntries(this.sessions)), {
        mode: 0o600,
      });
    } catch {
      /* ignore */
    }
  }

  /** Write remaining changes immediately on SIGTERM etc. */
  flushSessions(): void {
    this.saveNow();
  }

  /**
   * Current valid access token: the file wins (written from env or auto-generated
   * on first start). The file is re-read on every login so a token rotated via
   * `rftoken` applies without restarting.
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

  /** Login: verify token + (TOTP code when 2FA is on) → issue session token */
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

  /** Verify a raw access token (e.g. for /api/auth/setup QR re-fetch) */
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

  /** Recent 2FA code (for local/console hints). Lets you log in without an authenticator app. */
  currentTotp(): string {
    return totpAt(this.totpSecret, Math.floor(Date.now() / 1000));
  }

  otpauthUrl(): string {
    return otpauthUrl(this.totpSecret);
  }
}

export const auth = new Auth();

/** Auth info for the startup log (excludes the token itself) */
export function authStartupInfo(): { twoFactorEnabled: boolean; hasToken: boolean; tokenFile: string; secretFile: string } {
  return {
    twoFactorEnabled: auth.twoFactorEnabled,
    hasToken: auth.token.length > 0,
    tokenFile: TOKEN_FILE,
    secretFile: SECRET_FILE,
  };
}

export { verifyTotp, otpauthUrl };
