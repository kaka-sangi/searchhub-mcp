// SQLite-backed store for OAuth 2.1 dynamic clients, auth codes, access/refresh tokens, users, login attempts.
// Single file, single table-per-entity, minimal schema. No ORM — pure SQL via bun:sqlite.
// ponytail: WAL + synchronous=NORMAL is mandatory here — single-handle DB + concurrent HTTP requests
//           from different Bun workers otherwise see stale reads for ~1-2s after a write.
import { Database } from "bun:sqlite";
import { mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";

const DATA_DIR = process.env.DATA_DIR ?? "./data";
if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });

const dbPath = join(DATA_DIR, "searchhub.db");
export const db = new Database(dbPath, { strict: true });
db.exec("PRAGMA journal_mode = WAL;");
db.exec("PRAGMA synchronous = NORMAL;");
db.exec("PRAGMA busy_timeout = 5000;");
db.exec("PRAGMA foreign_keys = ON;");

db.exec(`
  CREATE TABLE IF NOT EXISTS oauth_clients (
    client_id TEXT PRIMARY KEY,
    client_secret_hash TEXT,
    client_name TEXT NOT NULL,
    redirect_uris TEXT NOT NULL,
    grant_types TEXT NOT NULL,
    response_types TEXT NOT NULL DEFAULT '["code"]',
    token_endpoint_auth_method TEXT NOT NULL DEFAULT 'none',
    scope TEXT,
    client_id_issued_at INTEGER NOT NULL,
    client_secret_expires_at INTEGER,
    metadata TEXT
  );
  CREATE TABLE IF NOT EXISTS oauth_auth_codes (
    code TEXT PRIMARY KEY,
    client_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    redirect_uri TEXT NOT NULL,
    scope TEXT NOT NULL,
    code_challenge TEXT NOT NULL,
    code_challenge_method TEXT NOT NULL DEFAULT 'S256',
    expires_at INTEGER NOT NULL,
    used INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_auth_codes_expires ON oauth_auth_codes(expires_at);
  CREATE TABLE IF NOT EXISTS oauth_access_tokens (
    token TEXT PRIMARY KEY,
    client_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    scope TEXT NOT NULL,
    expires_at INTEGER NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_access_tokens_expires ON oauth_access_tokens(expires_at);
  CREATE TABLE IF NOT EXISTS oauth_refresh_tokens (
    token TEXT PRIMARY KEY,
    client_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    scope TEXT NOT NULL,
    access_token_jti TEXT NOT NULL,
    expires_at INTEGER NOT NULL,
    revoked INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_refresh_tokens_expires ON oauth_refresh_tokens(expires_at);
  CREATE TABLE IF NOT EXISTS oauth_users (
    user_id TEXT PRIMARY KEY,
    username TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS oauth_login_attempts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT NOT NULL,
    success INTEGER NOT NULL,
    attempted_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_login_attempts_user_time ON oauth_login_attempts(username, attempted_at);
`);

import { scryptSync, randomBytes, timingSafeEqual } from "node:crypto";

export function hashPassword(plain: string): string {
  const salt = randomBytes(16);
  const hash = scryptSync(plain, salt, 64, { N: 16384, r: 8, p: 1 });
  return `scrypt$${salt.toString("hex")}$${hash.toString("hex")}`;
}

export function verifyPassword(plain: string, stored: string): boolean {
  if (typeof stored !== "string") return false;
  const parts = stored.split("$");
  if (parts.length !== 3 || parts[0] !== "scrypt") return false;
  const [, saltHex, hashHex] = parts;
  if (!saltHex || !hashHex) return false;
  let salt: Buffer, expected: Buffer;
  try {
    salt = Buffer.from(saltHex, "hex");
    expected = Buffer.from(hashHex, "hex");
  } catch {
    return false;
  }
  if (expected.length === 0) return false;
  const actual = scryptSync(plain, salt, expected.length, { N: 16384, r: 8, p: 1 });
  return timingSafeEqual(expected, actual);
}

export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}

const RATE_WINDOW_S = 15 * 60;
const RATE_MAX_FAILS = 5;
export function checkRateLimit(username: string): { ok: boolean; retryAfter?: number } {
  const since = Math.floor(Date.now() / 1000) - RATE_WINDOW_S;
  const row = db
    .query(`SELECT count(*) AS c FROM oauth_login_attempts WHERE username = ? AND success = 0 AND attempted_at >= ?`)
    .get(username, since) as { c: number } | null;
  const fails = row?.c ?? 0;
  if (fails < RATE_MAX_FAILS) return { ok: true };
  const oldest = db
    .query(`SELECT attempted_at FROM oauth_login_attempts WHERE username = ? AND success = 0 AND attempted_at >= ? ORDER BY attempted_at ASC LIMIT 1`)
    .get(username, since) as { attempted_at: number } | null;
  const retryAfter = oldest ? Math.max(0, oldest.attempted_at + RATE_WINDOW_S - Math.floor(Date.now() / 1000)) : 0;
  return { ok: false, retryAfter };
}
export function recordLoginAttempt(username: string, success: boolean): void {
  db.query(`INSERT INTO oauth_login_attempts (username, success, attempted_at) VALUES (?, ?, ?)`)
    .run(username, success ? 1 : 0, Math.floor(Date.now() / 1000));
}
