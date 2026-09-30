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
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

/** Integration tests isolate auth state without repurposing the process home. */
const TEST_STATE_DIR = process.env.NODE_ENV === "test"
  ? process.env.PI_WEB_TEST_STATE_DIR?.trim()
  : undefined;
const STATE_DIR = TEST_STATE_DIR
  ? resolve(TEST_STATE_DIR)
  : join(homedir(), ".pi", "web-chat");
const TWO_FACTOR_ENABLED = process.env.PI_WEB_2FA !== "off";
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
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

function readPrivateFile(file: string): string {
  // mode only affects new files; repair an existing file before reading it.
  chmodSync(file, 0o600);
  return readFileSync(file, "utf8").trim();
}

function writePrivateFile(file: string, value: string): void {
  if (existsSync(file)) chmodSync(file, 0o600);
  writeFileSync(file, value, { mode: 0o600 });
  chmodSync(file, 0o600);
}

function readOrCreate(file: string, generate: () => string): string {
  if (existsSync(file)) {
    const existing = readPrivateFile(file);
    if (existing) return existing;
  }
  const value = generate();
  writePrivateFile(file, value + "\n");
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

function verifyTotp(secret: string, code: string, nowMs = Date.now()): boolean {
  const clean = code.trim().replace(/\s/g, "");
  if (!/^\d{6}$/.test(clean)) return false;
  const now = Math.floor(nowMs / 1000);
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

export type SessionRevocationReason = "logout" | "expired";
type SessionRevocationListener = (sessionToken: string, reason: SessionRevocationReason) => void;

interface AuthOptions {
  stateDir?: string;
  token?: string;
  twoFactorEnabled?: boolean;
  now?: () => number;
}

export class Auth {
  readonly token: string;
  readonly twoFactorEnabled: boolean;
  readonly totpSecret: string;
  readonly tokenFile: string;
  readonly secretFile: string;
  private readonly sessionsFile: string;
  private readonly now: () => number;
  private readonly sessions = new Map<string, Session>();
  private readonly revocationListeners = new Set<SessionRevocationListener>();
  private saveTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(options: AuthOptions = {}) {
    const stateDir = resolve(options.stateDir ?? STATE_DIR);
    mkdirSync(stateDir, { recursive: true, mode: 0o700 });
    chmodSync(stateDir, 0o700);
    this.tokenFile = join(stateDir, "token");
    this.secretFile = join(stateDir, "2fa.secret");
    this.sessionsFile = join(stateDir, "sessions.json");
    this.now = options.now ?? Date.now;
    // An explicit launch token wins over a token retained by an earlier launch.
    this.token = this.readToken(options.token ?? process.env.PI_WEB_TOKEN);
    this.twoFactorEnabled = options.twoFactorEnabled ?? TWO_FACTOR_ENABLED;
    this.totpSecret = readOrCreate(this.secretFile, generateSecret);
    this.loadSessions();
    setInterval(() => this.cleanupSessions(), SESSION_CLEANUP_MS).unref();
  }

  /** Keep logins after restart: persist session tokens to disk */
  private loadSessions(): void {
    try {
      if (!existsSync(this.sessionsFile)) return;
      const raw: unknown = JSON.parse(readPrivateFile(this.sessionsFile));
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) return;
      const now = this.now();
      for (const [token, s] of Object.entries(raw)) {
        if (!s || typeof s !== "object" || Array.isArray(s)) continue;
        const lastUsed: unknown = s.lastUsed;
        if (typeof lastUsed !== "number" || !Number.isFinite(lastUsed) || lastUsed < 0 || lastUsed > now || now - lastUsed >= SESSION_TTL_MS) continue;
        this.sessions.set(token, {
          createdAt: typeof s.createdAt === "number" && Number.isFinite(s.createdAt) ? s.createdAt : lastUsed,
          lastUsed,
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
      writePrivateFile(this.sessionsFile, JSON.stringify(Object.fromEntries(this.sessions)));
    } catch {
      /* ignore */
    }
  }

  /** Write remaining changes immediately on SIGTERM etc. */
  flushSessions(): void {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = null;
    this.saveNow();
  }

  /**
   * The launch override is persisted once. Later logins re-read the file so a
   * token rotated via `rftoken` applies without restarting.
   */
  private readToken(launchToken?: string): string {
    const override = launchToken?.trim();
    if (override) {
      writePrivateFile(this.tokenFile, override + "\n");
      return override;
    }
    return readOrCreate(this.tokenFile, () => randomBytes(32).toString("hex"));
  }

  /** Login: verify token + (TOTP code when 2FA is on) → issue session token */
  login(
    rawToken: unknown,
    totpCode?: unknown,
  ): { sessionToken?: string; reason?: "token" | "2fa" } {
    if (typeof rawToken !== "string" || rawToken.length > 10_000) return { reason: "token" };
    if (!safeEqual(this.readToken(), rawToken.trim())) return { reason: "token" };
    if (this.twoFactorEnabled && (typeof totpCode !== "string" || totpCode.length > 128 || !verifyTotp(this.totpSecret, totpCode, this.now()))) {
      return { reason: "2fa" };
    }
    const sessionToken = randomBytes(32).toString("hex");
    const now = this.now();
    this.sessions.set(sessionToken, { createdAt: now, lastUsed: now });
    this.saveNow();
    return { sessionToken };
  }

  /** Notify transports when logout or expiry removes their authorization. */
  onSessionRevoked(listener: SessionRevocationListener): () => void {
    this.revocationListeners.add(listener);
    return () => { this.revocationListeners.delete(listener); };
  }

  /** Check idle expiry without renewing it, for an existing connection heartbeat. */
  isSessionValid(sessionToken: string): boolean {
    if (typeof sessionToken !== "string" || !sessionToken) return false;
    const s = this.sessions.get(sessionToken);
    if (!s) return false;
    if (this.now() - s.lastUsed >= SESSION_TTL_MS) {
      this.revokeSession(sessionToken, "expired");
      this.scheduleSave();
      return false;
    }
    return true;
  }

  validSession(sessionToken: string): boolean {
    if (!this.isSessionValid(sessionToken)) return false;
    this.sessions.get(sessionToken)!.lastUsed = this.now();
    this.scheduleSave();
    return true;
  }

  logout(sessionToken: string): void {
    this.revokeSession(sessionToken, "logout");
    this.saveNow();
  }

  private revokeSession(sessionToken: string, reason: SessionRevocationReason): void {
    if (!this.sessions.delete(sessionToken)) return;
    for (const listener of this.revocationListeners) {
      try {
        listener(sessionToken, reason);
      } catch {
        // One failed transport cleanup must not keep a revoked session alive or
        // prevent other listeners from closing their associated connections.
      }
    }
  }

  private cleanupSessions(): void {
    const now = this.now();
    let changed = false;
    for (const [token, s] of this.sessions) {
      if (now - s.lastUsed >= SESSION_TTL_MS) {
        this.revokeSession(token, "expired");
        changed = true;
      }
    }
    if (changed) this.scheduleSave();
  }

  /** Recent 2FA code (for local/console hints). Lets you log in without an authenticator app. */
  currentTotp(): string {
    return totpAt(this.totpSecret, Math.floor(this.now() / 1000));
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
    tokenFile: auth.tokenFile,
    secretFile: auth.secretFile,
  };
}

export { verifyTotp, otpauthUrl };
