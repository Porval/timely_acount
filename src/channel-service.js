import { createHash, randomUUID } from 'node:crypto';
import { AppError } from './service.js';

const nameValue = value => {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > 80) throw new AppError(400, '渠道名称需填写 1 到 80 个字符');
  return value.trim();
};
export function initializeChannels(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS channels (
    id TEXT PRIMARY KEY, name TEXT NOT NULL COLLATE NOCASE UNIQUE,
    enabled INTEGER NOT NULL DEFAULT 1 CHECK(enabled IN (0,1)), created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS account_channels (
    account_id TEXT PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
    channel_id TEXT NOT NULL REFERENCES channels(id)
  );
  CREATE INDEX IF NOT EXISTS account_channels_channel ON account_channels(channel_id);
  CREATE TABLE IF NOT EXISTS management_requests (
    request_key TEXT PRIMARY KEY, type TEXT NOT NULL, payload_hash TEXT NOT NULL, result_id TEXT NOT NULL
  );`);
}
export function resolveChannel(db, { channelId, providerName }, now) {
  if (channelId !== undefined) {
    if (typeof channelId !== 'string' || !channelId || channelId.length > 120) throw new AppError(400, '渠道 ID 不正确');
    const channel = db.prepare('SELECT * FROM channels WHERE id=?').get(channelId);
    if (!channel) throw new AppError(400, '渠道不存在');
    if (!channel.enabled) throw new AppError(409, '渠道已停用，不能新增或移入账号');
    return channel;
  }
  const name = nameValue(providerName);
  let channel = db.prepare('SELECT * FROM channels WHERE name=? COLLATE NOCASE').get(name);
  if (!channel) {
    const id = randomUUID();
    db.prepare('INSERT INTO channels(id,name,enabled,created_at,updated_at) VALUES(?,?,1,?,?)').run(id, name, now, now);
    channel = db.prepare('SELECT * FROM channels WHERE id=?').get(id);
  }
  if (!channel.enabled) throw new AppError(409, '渠道已停用，不能新增或移入账号');
  return channel;
}
export function backfillChannels(db) {
  db.transaction(() => {
    const rows = db.prepare('SELECT a.* FROM accounts a LEFT JOIN account_channels ac ON ac.account_id=a.id WHERE ac.account_id IS NULL').all();
    for (const account of rows) {
      const channel = resolveChannel(db, { providerName: account.provider_name }, account.created_at);
      db.prepare('INSERT INTO account_channels(account_id,channel_id) VALUES(?,?)').run(account.id, channel.id);
    }
  }).immediate();
}
const publicChannel = value => ({ id: value.id, name: value.name, enabled: Boolean(value.enabled), createdAt: value.created_at, updatedAt: value.updated_at, accountCount: value.accountCount ?? 0 });

export class ChannelService {
  constructor(store, accounts, now = Date.now) { this.store = store; this.db = store.db; this.accounts = accounts; this.now = now; }
  get(id) {
    const row = this.db.prepare('SELECT c.*, (SELECT count(*) FROM account_channels WHERE channel_id=c.id) AS accountCount FROM channels c WHERE id=?').get(id);
    if (!row) throw new AppError(404, '渠道不存在');
    return publicChannel(row);
  }
  list() { return { channels: this.db.prepare('SELECT c.*, (SELECT count(*) FROM account_channels WHERE channel_id=c.id) AS accountCount FROM channels c ORDER BY created_at DESC, rowid DESC').all().map(publicChannel) }; }
  once(key, type, payload, create, read) {
    if (typeof key !== 'string' || !/^[A-Za-z0-9_-]{16,120}$/.test(key)) throw new AppError(400, '请提供有效的 Idempotency-Key');
    const hash = createHash('sha256').update(JSON.stringify(payload)).digest('hex');
    return this.db.transaction(() => {
      const existing = this.db.prepare('SELECT * FROM management_requests WHERE request_key=?').get(key);
      if (existing) {
        if (existing.type !== type || existing.payload_hash !== hash) throw new AppError(409, '请求编号已用于其他内容');
        return { value: read(existing.result_id), created: false };
      }
      const value = create();
      this.db.prepare('INSERT INTO management_requests VALUES(?,?,?,?)').run(key, type, hash, value.id);
      return { value, created: true };
    }).immediate();
  }
  create(input, key) {
    const name = nameValue(input.name);
    const result = this.once(key, 'channel', { name }, () => {
      if (this.db.prepare('SELECT 1 FROM channels WHERE name=? COLLATE NOCASE').get(name)) throw new AppError(409, '渠道名称已存在');
      const id = randomUUID(); const now = this.now();
      this.db.prepare('INSERT INTO channels VALUES(?,?,1,?,?)').run(id, name, now, now);
      return this.get(id);
    }, id => this.get(id));
    return { channel: result.value, created: result.created };
  }
  update(id, input) {
    if (input.name === undefined && input.enabled === undefined) throw new AppError(400, '请提供渠道名称或启用状态');
    if (input.enabled !== undefined && typeof input.enabled !== 'boolean') throw new AppError(400, '启用状态不正确');
    return this.db.transaction(() => {
      const current = this.get(id); const name = input.name === undefined ? current.name : nameValue(input.name);
      const enabled = input.enabled === undefined ? current.enabled : input.enabled;
      if (this.db.prepare('SELECT 1 FROM channels WHERE name=? COLLATE NOCASE AND id<>?').get(name, id)) throw new AppError(409, '渠道名称已存在');
      if (!enabled && this.db.prepare("SELECT 1 FROM accounts a JOIN account_channels ac ON ac.account_id=a.id WHERE ac.channel_id=? AND a.role='admin' AND a.enabled=1").get(id)) throw new AppError(409, '该渠道包含启用的后台管理员，不能直接停用');
      this.db.prepare('UPDATE channels SET name=?,enabled=?,updated_at=? WHERE id=?').run(name, Number(enabled), this.now(), id);
      this.db.prepare('UPDATE accounts SET provider_name=?,updated_at=? WHERE id IN (SELECT account_id FROM account_channels WHERE channel_id=?)').run(name, this.now(), id);
      if (!enabled) {
        this.db.prepare('DELETE FROM sessions WHERE account_id IN (SELECT account_id FROM account_channels WHERE channel_id=?)').run(id);
        this.db.prepare('DELETE FROM otp_challenges WHERE mobile IN (SELECT a.mobile FROM accounts a JOIN account_channels ac ON ac.account_id=a.id WHERE ac.channel_id=?)').run(id);
      }
      return { channel: this.get(id) };
    }).immediate();
  }
  listAccounts(query = {}) {
    const page = Number(query.page || 1); const pageSize = Number(query.pageSize || 20);
    if (!Number.isSafeInteger(page) || page < 1 || !Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 100) throw new AppError(400, '分页参数不正确');
    const search = typeof query.search === 'string' ? query.search.trim().toLowerCase() : '';
    if (search.length > 100) throw new AppError(400, '搜索内容过长');
    if (query.channelId) this.get(query.channelId);
    const accounts = this.accounts.listAccounts().filter(account => (!query.channelId || account.channelId === query.channelId) && (!search || `${account.personName} ${account.mobile} ${account.providerName}`.toLowerCase().includes(search)));
    return { accounts: accounts.slice((page - 1) * pageSize, page * pageSize), total: accounts.length, page, pageSize };
  }
  createAccount(input, key) {
    if (input.role !== undefined && input.role !== 'member') throw new AppError(400, '渠道账号只支持服务商成员身份');
    if (typeof input.channelId !== 'string') throw new AppError(400, '请选择所属渠道');
    const payload = { channelId: input.channelId, personName: input.personName, mobile: input.mobile };
    const result = this.once(key, 'channel-account', payload, () => this.accounts.createAccount({ ...payload, role: 'member' }), id => this.accounts.listAccounts().find(account => account.id === id));
    return { account: result.value, created: result.created };
  }
  updateAccount(id, input) {
    const current = this.accounts.listAccounts().find(account => account.id === id);
    if (!current) throw new AppError(404, '账号不存在');
    if (current.role !== 'member') throw new AppError(403, '此页面只能编辑服务商成员账号');
    if (input.role !== undefined || input.providerName !== undefined) throw new AppError(400, '此接口不能指定角色或服务商名称');
    return { account: this.accounts.updateAccount(id, { channelId: input.channelId, personName: input.personName, mobile: input.mobile, enabled: input.enabled }) };
  }
}
