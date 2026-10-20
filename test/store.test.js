import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { SQLiteStore } from '../src/store.js';
import { AccountService } from '../src/service.js';

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'account-database-test-'));
  const stores = [];
  t.after(() => { for (const store of stores) store.close(); rmSync(dir, { recursive: true, force: true }); });
  return { dir, path: join(dir, 'accounts.sqlite'), open(path, options) { const store = new SQLiteStore(path, options); stores.push(store); return store; } };
}
const input = { providerName: '服务商', personName: '管理员', mobile: '13800138000', role: 'admin' };

test('SQL 表实际落盘，事务失败回滚，手机号数据库唯一约束', (t) => {
  const f = fixture(t);
  const store = f.open(f.path);
  const service = new AccountService({ store });
  const created = service.createAccount(input);
  assert.equal(store.db.prepare('SELECT mobile FROM accounts WHERE id = ?').get(created.id).mobile, input.mobile);
  assert.equal(readFileSync(f.path).subarray(0, 16).toString(), 'SQLite format 3\u0000');
  assert.throws(() => store.update((state) => { state.accounts[0].personName = '不应保存'; throw new Error('rollback'); }), /rollback/);
  assert.equal(service.listAccounts()[0].personName, input.personName);
  assert.throws(() => store.update((state) => { state.accounts.push({ ...state.accounts[0], id: 'duplicate' }); }), /UNIQUE constraint/);
  assert.equal(service.listAccounts().length, 1);
});

test('迁移旧 JSON 全部数据，仅迁移一次，原文件保留', (t) => {
  const f = fixture(t);
  const legacyFile = join(f.dir, 'accounts.json');
  const account = { id: 'legacy-id', ...input, enabled: true, createdAt: 1, updatedAt: 1,
    session: { tokenHash: 'token-hash', expiresAt: Date.now() + 100000 } };
  const original = JSON.stringify({ version: 1, accounts: [account], challenges: {
    [input.mobile]: { hash: 'code-hash', salt: 'salt', expiresAt: 9999999999999, attempts: 1 },
  }, deliveries: { [input.mobile]: [10, 20] } });
  writeFileSync(legacyFile, original);
  const store = f.open(f.path, { legacyFile });
  assert.equal(store.read().accounts[0].session.tokenHash, 'token-hash');
  assert.equal(store.read().challenges[input.mobile].attempts, 1);
  assert.deepEqual(store.read().deliveries[input.mobile], [10, 20]);
  new AccountService({ store }).updateAccount('legacy-id', { personName: '数据库新名称' });
  store.close();
  const reopened = f.open(f.path, { legacyFile });
  assert.equal(reopened.read().accounts[0].personName, '数据库新名称');
  assert.equal(reopened.read().accounts.length, 1);
  assert.equal(readFileSync(legacyFile, 'utf8'), original);
});

test('损坏的旧数据迁移失败并回滚；已有数据库不会被旧 JSON 覆盖', (t) => {
  const f = fixture(t);
  const legacyFile = join(f.dir, 'accounts.json');
  writeFileSync(legacyFile, '{invalid');
  assert.throws(() => f.open(f.path, { legacyFile }));
  const store = f.open(f.path);
  assert.equal(store.read().accounts.length, 0);
  assert.equal(store.db.prepare('SELECT count(*) AS count FROM migrations').get().count, 0);
  new AccountService({ store }).createAccount(input);
  store.close();
  const reopened = f.open(f.path, { legacyFile });
  assert.equal(reopened.read().accounts[0].mobile, input.mobile);
});

test('两个连接即时读取新账户、会话和撤销；新登录在另一连接生效', async (t) => {
  const f = fixture(t);
  const first = f.open(f.path);
  const second = f.open(f.path);
  let time = Date.now();
  const serviceA = new AccountService({ store: first, now: () => time, sendSms: async () => {} });
  const serviceB = new AccountService({ store: second, now: () => time, sendSms: async () => {} });
  serviceA.createAccount(input);
  assert.equal(serviceB.listAccounts().length, 1);
  let { code } = await serviceA.requestCode(input.mobile);
  const sessionA = serviceB.login(input.mobile, code);
  assert.equal(serviceA.authenticate(sessionA.token).mobile, input.mobile);
  time += 60001;
  ({ code } = await serviceB.requestCode(input.mobile));
  const sessionB = serviceA.login(input.mobile, code);
  assert.throws(() => serviceB.authenticate(sessionA.token), /其他设备/);
  assert.equal(serviceB.authenticate(sessionB.token).mobile, input.mobile);
  serviceB.logout(sessionB.token);
  assert.throws(() => serviceA.authenticate(sessionB.token), /其他设备/);
});

test('4 个进程并发新增账户无丢失，持久化事务锁生效', async (t) => {
  const f = fixture(t);
  const store = f.open(f.path);
  const storeUrl = pathToFileURL(resolve('src/store.js')).href;
  const serviceUrl = pathToFileURL(resolve('src/service.js')).href;
  const code = `import { SQLiteStore } from ${JSON.stringify(storeUrl)};
    import { AccountService } from ${JSON.stringify(serviceUrl)};
    const store = new SQLiteStore(process.argv[1]);
    try { new AccountService({ store }).createAccount({ providerName: '并发服务商', personName: '并发成员', mobile: process.argv[2] }); }
    finally { store.close(); }`;
  await Promise.all(['13800138001', '13800138002', '13800138003', '13800138004'].map((phone) => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', code, f.path, phone]);
    let error = '';
    child.stderr.on('data', (data) => { error += data; });
    child.on('error', reject);
    child.on('exit', (status) => status === 0 ? resolve() : reject(new Error(error)));
  })));
  assert.equal(store.read().accounts.length, 4);
  assert.equal(store.db.pragma('integrity_check', { simple: true }), 'ok');
});
