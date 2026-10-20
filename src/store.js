import Database from 'better-sqlite3';
import { initializeChannels, backfillChannels } from './channel-service.js';
import { existsSync, mkdirSync, readFileSync, chmodSync } from 'node:fs';
import { dirname } from 'node:path';

export class SQLiteStore {
  constructor(path, { legacyFile } = {}) {
    this.path = path;
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new Database(path);
    chmodSync(path, 0o600);
    this.db.pragma('busy_timeout = 5000');
    this.db.pragma('foreign_keys = ON');
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = FULL');
    try {
      const version = this.db.pragma('user_version', { simple: true });
      if (version > 1) throw new Error('数据库版本高于当前工程支持的版本');
      this.db.transaction(() => {
        this.db.exec(`
          CREATE TABLE IF NOT EXISTS accounts (
            id TEXT PRIMARY KEY,
            provider_name TEXT NOT NULL CHECK(length(trim(provider_name)) BETWEEN 1 AND 80),
            person_name TEXT NOT NULL CHECK(length(trim(person_name)) BETWEEN 1 AND 80),
            mobile TEXT NOT NULL UNIQUE CHECK(length(mobile) = 11),
            role TEXT NOT NULL CHECK(role IN ('admin', 'member')),
            enabled INTEGER NOT NULL CHECK(enabled IN (0, 1)),
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL
          );
          CREATE TABLE IF NOT EXISTS sessions (
            account_id TEXT PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
            token_hash TEXT NOT NULL UNIQUE,
            expires_at INTEGER NOT NULL
          );
          CREATE INDEX IF NOT EXISTS sessions_expiry ON sessions(expires_at);
          CREATE TABLE IF NOT EXISTS otp_challenges (
            mobile TEXT PRIMARY KEY,
            code_hash TEXT NOT NULL,
            salt TEXT NOT NULL,
            expires_at INTEGER NOT NULL,
            attempts INTEGER NOT NULL CHECK(attempts BETWEEN 0 AND 5)
          );
          CREATE INDEX IF NOT EXISTS otp_expiry ON otp_challenges(expires_at);
          CREATE TABLE IF NOT EXISTS sms_deliveries (
            mobile TEXT NOT NULL,
            requested_at INTEGER NOT NULL,
            PRIMARY KEY(mobile, requested_at)
          );
          CREATE TABLE IF NOT EXISTS migrations (name TEXT PRIMARY KEY, applied_at INTEGER NOT NULL);
          PRAGMA user_version = 1;
        `);
      }).immediate();
      initializeChannels(this.db);
      this.readTransaction = this.db.transaction(() => this.readState());
      this.writeTransaction = this.db.transaction((fn) => {
        const state = this.readState();
        const result = fn(state);
        if (result && typeof result.then === 'function') throw new Error('数据库事务回调必须同步执行');
        this.saveState(state);
        return result;
      });
      if (legacyFile && existsSync(legacyFile)) this.migrateLegacy(legacyFile);
      backfillChannels(this.db);
    } catch (error) {
      this.db.close();
      throw error;
    }
  }
  readState() {
    const accounts = this.db.prepare(`
      SELECT a.id, coalesce(c.name,a.provider_name) AS providerName, a.person_name AS personName, a.mobile, a.role,
             a.enabled, a.created_at AS createdAt, a.updated_at AS updatedAt,
             ac.channel_id AS channelId, c.enabled AS channelEnabled,
             s.token_hash AS tokenHash, s.expires_at AS expiresAt
      FROM accounts a LEFT JOIN sessions s ON s.account_id = a.id
      LEFT JOIN account_channels ac ON ac.account_id=a.id LEFT JOIN channels c ON c.id=ac.channel_id ORDER BY a.rowid
    `).all().map(({ tokenHash, expiresAt, ...account }) => ({ ...account, enabled: Boolean(account.enabled), channelEnabled: account.channelEnabled === null ? true : Boolean(account.channelEnabled),
      session: tokenHash ? { tokenHash, expiresAt } : null }));
    const challenges = Object.fromEntries(this.db.prepare('SELECT * FROM otp_challenges').all().map((row) =>
      [row.mobile, { hash: row.code_hash, salt: row.salt, expiresAt: row.expires_at, attempts: row.attempts }]));
    const deliveries = {};
    for (const row of this.db.prepare('SELECT * FROM sms_deliveries ORDER BY requested_at').all()) {
      (deliveries[row.mobile] ||= []).push(row.requested_at);
    }
    return { version: 1, accounts, challenges, deliveries };
  }
  read() { return this.readTransaction(); }
  update(fn) { return this.writeTransaction.immediate(fn); }
  saveState(state) {
    const insertAccount = this.db.prepare(`INSERT INTO accounts
      (id, provider_name, person_name, mobile, role, enabled, created_at, updated_at)
      VALUES (@id, @providerName, @personName, @mobile, @role, @enabled, @createdAt, @updatedAt)
      ON CONFLICT(id) DO UPDATE SET provider_name=excluded.provider_name, person_name=excluded.person_name,
        mobile=excluded.mobile, role=excluded.role, enabled=excluded.enabled, updated_at=excluded.updated_at`);
    const ids = new Set(state.accounts.map((a) => a.id));
    for (const { id } of this.db.prepare('SELECT id FROM accounts').all()) {
      if (!ids.has(id)) this.db.prepare('DELETE FROM accounts WHERE id = ?').run(id);
    }
    const sessionStatement = this.db.prepare(`INSERT INTO sessions (account_id, token_hash, expires_at) VALUES (?, ?, ?)
      ON CONFLICT(account_id) DO UPDATE SET token_hash=excluded.token_hash, expires_at=excluded.expires_at`);
    for (const account of state.accounts) {
      insertAccount.run({ ...account, enabled: Number(account.enabled) });
      if (account.channelId) this.db.prepare('INSERT INTO account_channels(account_id,channel_id) VALUES(?,?) ON CONFLICT(account_id) DO UPDATE SET channel_id=excluded.channel_id').run(account.id, account.channelId);
      if (account.session) sessionStatement.run(account.id, account.session.tokenHash, account.session.expiresAt);
      else this.db.prepare('DELETE FROM sessions WHERE account_id = ?').run(account.id);
    }
    this.db.prepare('DELETE FROM otp_challenges').run();
    const insertChallenge = this.db.prepare('INSERT INTO otp_challenges (mobile, code_hash, salt, expires_at, attempts) VALUES (?, ?, ?, ?, ?)');
    for (const [mobile, item] of Object.entries(state.challenges)) {
      insertChallenge.run(mobile, item.hash, item.salt, item.expiresAt, item.attempts);
    }
    this.db.prepare('DELETE FROM sms_deliveries').run();
    const insertDelivery = this.db.prepare('INSERT INTO sms_deliveries (mobile, requested_at) VALUES (?, ?)');
    for (const [mobile, times] of Object.entries(state.deliveries)) {
      for (const time of times) insertDelivery.run(mobile, time);
    }
  }
  migrateLegacy(path) {
    this.db.transaction(() => {
      if (this.db.prepare('SELECT 1 FROM migrations WHERE name = ?').get('legacy-json-v1')) return;
      // Existing database records are authoritative; never overwrite them with older JSON.
      if (!this.db.prepare('SELECT 1 FROM accounts LIMIT 1').get()) {
        const state = JSON.parse(readFileSync(path, 'utf8'));
        if (state.version !== 1 || !Array.isArray(state.accounts) || !state.challenges || !state.deliveries) {
          throw new Error('旧 JSON 数据格式不正确，停止迁移以保护原数据');
        }
        this.saveState(state);
      }
      this.db.prepare('INSERT INTO migrations (name, applied_at) VALUES (?, ?)').run('legacy-json-v1', Date.now());
    }).immediate();
  }
  close() { if (this.db.open) this.db.close(); }
}
