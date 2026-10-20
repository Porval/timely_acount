import test from 'node:test';
import { get as httpGet } from 'node:http';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../src/server.js';
import { SQLiteStore } from '../src/store.js';
import { AccountService } from '../src/service.js';
import { SESSION_TTL, OTP_TTL, loadConfig } from '../src/config.js';

async function fixture(t, options = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'extras-account-test-'));
  const store = new SQLiteStore(join(dir, 'accounts.sqlite'));
  let time = Date.now();
  const sms = [];
  const now = () => time;
  const sendSms = async (message) => { sms.push(message); };
  const service = new AccountService({ store, sendSms, now });
  const admin = service.createAccount({ providerName: '测试服务商', personName: '测试管理员', mobile: '13800138000', role: 'admin' });
  const member = service.createAccount({ providerName: '另一服务商', personName: '普通成员', mobile: '13900139000' });
  const config = { smsMode: 'console', production: false, databaseFile: store.path, ...options };
  const server = createApp({ config, store, sendSms, now });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  t.after(() => new Promise((resolve) => {
    server.close(() => { rmSync(dir, { recursive: true, force: true }); resolve(); });
    server.closeAllConnections();
  }));
  const base = `http://127.0.0.1:${server.address().port}`;
  const request = async (path, { cookie, method = 'GET', input, headers } = {}) => {
    const response = await fetch(base + path, { method, headers: { ...(cookie ? { Cookie: cookie } : {}), ...(input ? { 'Content-Type': 'application/json' } : {}), ...headers }, ...(input ? { body: JSON.stringify(input) } : {}) });
    const data = await response.json();
    return { status: response.status, data, cookie: response.headers.get('set-cookie') };
  };
  const login = async (mobile = admin.mobile) => {
    await service.requestCode(mobile);
    return request('/api/auth/login', { method: 'POST', input: { mobile, code: sms.at(-1).code } });
  };
  return { admin, member, store, service, request, login, sms, config, now, base, advance: (amount) => { time += amount; } };
}

test('健康检查、页面与未知路由；账户接口必须登录', async (t) => {
  const f = await fixture(t);
  assert.deepEqual((await f.request('/api/health')).data, { status: 'ok', service: 'extras-account' });
  assert.equal((await f.request('/api/missing')).status, 404);
  assert.equal((await f.request('/api/accounts')).status, 401);
  const page = await fetch(f.base);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /账户列表/);
});

test('HttpOnly 会话严格有效 7 天，访问不会续期；响应不暴露 token', async (t) => {
  const f = await fixture(t);
  const result = await f.login();
  assert.equal(result.status, 200);
  assert.equal(result.data.expiresAt, f.now() + SESSION_TTL);
  assert.equal(result.data.token, undefined);
  assert.match(result.cookie, /HttpOnly/);
  assert.match(result.cookie, /SameSite=Strict/);
  assert.match(result.cookie, /Max-Age=604800/);
  f.advance(SESSION_TTL - 1);
  assert.equal((await f.request('/api/auth/me', { cookie: result.cookie })).status, 200);
  f.advance(1);
  assert.equal((await f.request('/api/auth/me', { cookie: result.cookie })).status, 401);
});

test('新登录替换旧会话；验证码仅使用一次', async (t) => {
  const f = await fixture(t);
  const first = await f.login();
  const code = f.sms.at(-1).code;
  assert.equal((await f.request('/api/auth/login', { method: 'POST', input: { mobile: f.admin.mobile, code } })).status, 401);
  f.advance(60001);
  const second = await f.login();
  assert.notEqual(first.cookie, second.cookie);
  assert.equal((await f.request('/api/auth/me', { cookie: first.cookie })).status, 401);
  assert.equal((await f.request('/api/auth/me', { cookie: second.cookie })).status, 200);
});

test('退出即吊销；过期会话无法访问', async (t) => {
  const f = await fixture(t);
  const login = await f.login();
  const out = await f.request('/api/auth/logout', { method: 'POST', cookie: login.cookie });
  assert.equal(out.status, 200);
  assert.match(out.cookie, /Max-Age=0/);
  assert.equal((await f.request('/api/auth/me', { cookie: login.cookie })).status, 401);
});

test('验证码 5 分钟过期，错误 5 次作废，60 秒发送冷却', async (t) => {
  const f = await fixture(t);
  const { code } = await f.service.requestCode(f.admin.mobile);
  await assert.rejects(f.service.requestCode(f.admin.mobile), /60 秒/);
  f.advance(OTP_TTL);
  assert.throws(() => f.service.login(f.admin.mobile, code), /验证码无效/);
  const next = await f.service.requestCode(f.admin.mobile);
  const wrong = next.code === '000000' ? '111111' : '000000';
  for (let i = 0; i < 5; i++) assert.throws(() => f.service.login(f.admin.mobile, wrong), /验证码无效/);
  assert.throws(() => f.service.login(f.admin.mobile, next.code), /验证码无效/);
});

test('重发使旧验证码作废；未知手机号不发送短信、不创建账户', async (t) => {
  const f = await fixture(t);
  const first = await f.service.requestCode(f.admin.mobile);
  f.advance(60001);
  const second = await f.service.requestCode(f.admin.mobile);
  if (first.code !== second.code) assert.throws(() => f.service.login(f.admin.mobile, first.code), /验证码无效/);
  assert.ok(f.service.login(f.admin.mobile, second.code));
  const count = f.sms.length;
  const unknown = await f.request('/api/auth/code', { method: 'POST', input: { mobile: '13700137000' } });
  assert.equal(unknown.status, 200);
  assert.equal(unknown.data.devCode, undefined);
  assert.equal(f.sms.length, count);
  assert.equal(f.service.listAccounts().length, 2);
});

test('管理员新增与编辑；手机号唯一；普通成员禁止管理', async (t) => {
  const f = await fixture(t);
  const admin = await f.login();
  const member = await f.login(f.member.mobile);
  assert.equal((await f.request('/api/accounts', { cookie: member.cookie })).status, 403);
  const input = { providerName: '新服务商', personName: '张三', mobile: '13600136000' };
  const created = await f.request('/api/accounts', { method: 'POST', cookie: admin.cookie, input });
  assert.equal(created.status, 201);
  assert.equal(created.data.account.providerName, '新服务商');
  assert.equal((await f.request('/api/accounts', { method: 'POST', cookie: admin.cookie, input })).status, 409);
  const updated = await f.request(`/api/accounts/${created.data.account.id}`, { method: 'PATCH', cookie: admin.cookie, input: { personName: '李四' } });
  assert.equal(updated.data.account.personName, '李四');
  const listed = await f.request('/api/accounts', { cookie: admin.cookie });
  assert.equal(listed.data.accounts.length, 3);
  assert.equal(listed.data.accounts[0].session, undefined);
});

test('停用、变更手机号或角色立即吊销会话；最后一名管理员不可停用', async (t) => {
  const f = await fixture(t);
  assert.throws(() => f.service.updateAccount(f.admin.id, { enabled: false }), /至少保留/);
  assert.throws(() => f.service.updateAccount(f.admin.id, { role: 'member' }), /至少保留/);
  let login = await f.login(f.member.mobile);
  f.service.updateAccount(f.member.id, { mobile: '13500135000' });
  assert.equal((await f.request('/api/auth/me', { cookie: login.cookie })).status, 401);
  login = await f.login('13500135000');
  f.service.updateAccount(f.member.id, { role: 'admin' });
  assert.equal((await f.request('/api/auth/me', { cookie: login.cookie })).status, 401);
  f.advance(60001);
  login = await f.login('13500135000');
  f.service.updateAccount(f.member.id, { enabled: false });
  assert.equal((await f.request('/api/auth/me', { cookie: login.cookie })).status, 401);
});

test('会话跨重启保留；磁盘不保存明文 token 或验证码字段', async (t) => {
  const f = await fixture(t);
  const login = await f.login();
  const token = login.cookie.split(';')[0].split('=')[1];
  const restartedStore = new SQLiteStore(f.store.path);
  t.after(() => restartedStore.close());
  const restarted = new AccountService({ store: restartedStore, now: f.now });
  assert.equal(restarted.authenticate(token).mobile, f.admin.mobile);
  assert.notEqual(f.store.db.prepare('SELECT token_hash FROM sessions').get().token_hash, token);
  await f.service.requestCode(f.member.mobile);
  assert.equal(f.store.read().challenges[f.member.mobile].code, undefined);
});

test('输入校验、跨站防护和 IP 限流', async (t) => {
  const f = await fixture(t);
  assert.equal((await f.request('/api/auth/code', { method: 'POST', input: { mobile: '123' } })).status, 400);
  assert.equal((await f.request('/api/auth/code', { method: 'POST', input: { mobile: f.admin.mobile }, headers: { Origin: 'https://evil.example' } })).status, 403);
  const spoofedHost = await new Promise((resolve, reject) => {
    httpGet(f.base + '/api/config', { headers: { Host: 'attacker.example:3100' } }, (response) => {
      response.resume(); resolve(response.statusCode);
    }).on('error', reject);
  });
  assert.equal(spoofedHost, 403);
  const broken = await fetch(f.base + '/api/auth/code', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{' });
  assert.equal(broken.status, 400);
  for (let i = 0; i < 18; i++) await f.request('/api/auth/code', { method: 'POST', input: { mobile: '123' } });
  assert.equal((await f.request('/api/auth/code', { method: 'POST', input: { mobile: '123' } })).status, 429);
});

test('真实短信模式不返回开发验证码；发送失败的验证码作废', async (t) => {
  const f = await fixture(t, { smsMode: 'remote' });
  const result = await f.request('/api/auth/code', { method: 'POST', input: { mobile: f.admin.mobile } });
  assert.equal(result.status, 200);
  assert.equal(result.data.devCode, undefined);
  f.service.sendSms = async () => { throw new Error('down'); };
  await assert.rejects(f.service.requestCode(f.member.mobile), /短信发送失败/);
  assert.equal(f.store.read().challenges[f.member.mobile], undefined);
});

test('生产强制 HTTPS 短信接口和 HTTPS 页面地址；开发验证码只能本机', () => {
  assert.throws(() => loadConfig({ NODE_ENV: 'production', SMS_MODE: 'console' }), /开发验证码/);
  assert.throws(() => loadConfig({ HOST: '0.0.0.0' }), /本机服务/);
  assert.throws(() => loadConfig({ NODE_ENV: 'production', DEBUG_SMS_HOST: 'http://example.com' }), /HTTPS/);
  const config = loadConfig({ NODE_ENV: 'production', DEBUG_SMS_HOST: 'https://sms.example.com', APP_ORIGIN: 'https://accounts.example.com' });
  assert.equal(config.smsMode, 'remote');
});
