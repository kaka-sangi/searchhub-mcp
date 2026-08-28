// SQLite-backed store for OAuth 2.1 dynamic clients, auth codes, access/refresh tokens.
// Single file, single table-per-entity, minimal schema. No ORM — pure SQL via bun:sqlite.
import { Database } from "bun:sqlite";
import { mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";

const DATA_DIR = process.env.DATA_DIR ?? "./data";
if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });

const dbPath = join(DATA_DIR, "searchhub.db");
export const db = new Database(dbPath);

// Init schema (idempotent — every CREATE uses IF NOT EXISTS).
db.exec(`
  CREATE TABLE IF NOT EXISTS oauth_clients (
    client_id TEXT PRIMARY KEY,
    client_secret_hash TEXT,                 -- nullable for public PKCE clients
    client_name TEXT NOT NULL,
    redirect_uris TEXT NOT NULL,             -- JSON array
    grant_types TEXT NOT NULL,               -- JSON array
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
    token TEXT PRIMARY KEY,                  -- opaque, hashed at rest
    client_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    scope TEXT NOT NULL,
    expires_at INTEGER NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_access_tokens_expires ON oauth_access_tokens(expires_at);

  CREATE TABLE IF NOT EXISTS oauth_refresh_tokens (
    token TEXT PRIMARY KEY,                  -- opaque, hashed at rest
    client_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    scope TEXT NOT NULL,
    access_token_jti TEXT NOT NULL,          -- bound to current access token
    expires_at INTEGER NOT NULL,
    revoked INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_refresh_tokens_expires ON oauth_refresh_tokens(expires_at);

  CREATE TABLE IF NOT EXISTS oauth_users (
    user_id TEXT PRIMARY KEY,                -- opaque internal id
    username TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,             -- bcrypt-equivalent: PBKDF2-SHA256
    created_at INTEGER NOT NULL
  );
`);

// ponytail: global lock, per-account locks if throughput matters.
// ponytail: PBKDF2-SHA256 over built-in crypto. Move to argon2id if CPU pressure matters.
// ponytail: bcrypt preferred over PBKDF2 for password hashing — switch to argon2id if installed.
import { pbkdf2Sync, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";

export function hashPassword(plain: string): string {
  const salt = randomBytes(16);
  const hash = scryptSync(plain, salt, 64, { N: 16384, r: 8, p: 1 });
  return `scrypt$${salt.toString("hex")}$${hash.toString("hex")}`;
}

export function verifyPassword(plain: string, stored: string): boolean {
  const [scheme, saltHex, hashHex] = stored.split("$");
  if (scheme !== "scrypt" || !saltHex || !hashHex) return false;
  const salt = Buffer.from(saltHex, "hex");
  const expected = Buffer.from(hashHex, "hex");
  const actual = scryptSync(plain, salt, expected.length, { N: 16384, r: 8, p: 1 });
  return timingSafeEqual(expected, actual);
}

export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}
