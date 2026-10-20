import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AccountService } from '../src/service.js';
import { SQLiteStore } from '../src/store.js';
import { createSmsSender, createSmsVerifier, DEFAULT_SMS_TEMPLATE } from '../src/sms.js';
import { loadConfig, SESSION_TTL } from '../src/config.js';
import { createApp } from '../src/server.js';

const mobile = '13800138000';
const config = { smsMode: 'remote', smsHost: 'https://sms.example.com/bff', smsCodeField: 'code' };
const response = (value, status = 200) => new Response(JSON.stringify(value), { status });
function fixture(t, verifySms = async ({ code }) => code === '123456') {
  const dir = mkdtempSync(join(tmpdir(), 'remote-sms-test-'));
  const store = new SQLiteStore(join(dir, 'accounts.sqlite'));
  let time = Date.now();
  const sent = [];
  const service = new AccountService({ store, now: () => time, sendSms: async (message) => { sent.push(message); }, verifySms });
  const account = service.createAccount({ mobile, providerName: '测试服务商', personName: '测试人员' });
  t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });
  return { service, store, account, sent, now: () => time, advance: (amount) => { time += amount; } };
}

test('发送适配器与仓库代码一致：number + 服务端 template，保留基础路径，不上传本地 code', async () => {
  const requests = [];
  const send = createSmsSender(config, async (url, options) => { requests.push({ url: String(url), options }); return response({ success: true, code: 'do-not-return' }); });
  const result = await send({ mobile, code: 'unused-local-code' });
  assert.equal(result, undefined);
  assert.equal(requests[0].url, 'https://sms.example.com/bff/api/sms/requestCode');
  assert.deepEqual(JSON.parse(requests[0].options.body), { number: mobile, template: DEFAULT_SMS_TEMPLATE });
  assert.equal(requests[0].options.redirect, 'error');
  assert.equal(requests[0].options.headers.Authorization, undefined);
});

test('验证发送 phone 和可配置验证码字段；只认明确验证成功，不误认 BFF 其他响应', async () => {
  let payload;
  const verify = createSmsVerifier({ ...config, smsCodeField: 'verifyCode' }, async (url, options) => {
    assert.equal(String(url), 'https://sms.example.com/bff/api/sms/verifyCode');
    payload = JSON.parse(options.body); return response({ success: true });
  });
  assert.equal(await verify({ mobile, code: '123456' }), true);
  assert.deepEqual(payload, { phone: mobile, verifyCode: '123456' });
  for (const body of [{ success: false }, {}, { error: false, data: { token: 'upstream' } }, { success: 'true' }, { success: true, error: true }, { success: true, verified: false }]) {
    const failure = createSmsVerifier(config, async () => response(body));
    assert.equal(await failure({ mobile, code: '123456' }), false);
  }
});


test('真实短信服务手机号字段 number 与验证码 code 正确映射', async () => {
  let payload;
  const verify = createSmsVerifier({ ...config, smsPhoneField: 'number' }, async (url, options) => {
    payload = JSON.parse(options.body);
    return response({ success: true, verified: true });
  });
  assert.equal(await verify({ mobile, code: '123456' }), true);
  assert.deepEqual(payload, { number: mobile, code: '123456' });
  assert.throws(() => loadConfig({ SMS_VERIFY_PHONE_FIELD: 'mobile' }), /手机号字段/);
  assert.throws(() => loadConfig({ SMS_VERIFY_PHONE_FIELD: 'number', SMS_VERIFY_CODE_FIELD: 'number' }), /字段/);
});

test('网络失败、非 JSON、发送业务失败、429 或 HTTP 500 不会当作校验成功', async () => {
  const unavailable = createSmsVerifier(config, async () => { throw new Error('timeout'); });
  await assert.rejects(unavailable({ mobile, code: '123456' }), (e) => e.status === 502);
  const malformed = createSmsVerifier(config, async () => new Response('not json'));
  await assert.rejects(malformed({ mobile, code: '123456' }), (e) => e.status === 502);
  const serverError = createSmsVerifier(config, async () => response({ success: true }, 500));
  await assert.rejects(serverError({ mobile, code: '123456' }), (e) => e.status === 502);
  const limited = createSmsSender(config, async () => response({ success: false }, 429));
  await assert.rejects(limited({ mobile }), (e) => e.status === 429);
  const rejected = createSmsSender(config, async () => response({ success: false }));
  await assert.rejects(rejected({ mobile }), (e) => e.status === 502);
});

test('远程只申请和验证验证码；成功才发 7 天会话，第二次登录吊销第一次', async (t) => {
  const f = fixture(t);
  assert.deepEqual(await f.service.requestCode(mobile), {});
  assert.equal(f.sent[0].code, undefined);
  await assert.rejects(f.service.loginWithCode(mobile, '000000'), (e) => e.status === 401);
  const first = await f.service.loginWithCode(mobile, '123456');
  assert.equal(first.expiresAt, f.now() + SESSION_TTL);
  await assert.rejects(f.service.loginWithCode(mobile, '123456'), (e) => e.status === 401);
  assert.throws(() => f.service.login(mobile, '123456'), /远程验证码/);
  f.advance(60001);
  await f.service.requestCode(mobile);
  const second = await f.service.loginWithCode(mobile, '123456');
  assert.throws(() => f.service.authenticate(first.token), /其他设备/);
  assert.equal(f.service.authenticate(second.token).mobile, mobile);
});

test('远程验证错误 5 次作废；失败期间不创建 token', async (t) => {
  let calls = 0;
  const f = fixture(t, async () => { calls++; return false; });
  await f.service.requestCode(mobile);
  for (let i = 0; i < 6; i++) await assert.rejects(f.service.loginWithCode(mobile, '000000'), (e) => e.status === 401);
  assert.equal(calls, 5);
  assert.equal(f.store.db.prepare('SELECT COUNT(*) AS count FROM sessions').get().count, 0);
});

test('异步校验期间账户停用或验证码重发，旧验证成功也不得登录', async (t) => {
  let finish;
  const f = fixture(t, () => new Promise((resolve) => { finish = resolve; }));
  await f.service.requestCode(mobile);
  let pending = f.service.loginWithCode(mobile, '123456');
  f.service.updateAccount(f.account.id, { enabled: false });
  finish(true);
  await assert.rejects(pending, (e) => e.status === 401);
  f.service.updateAccount(f.account.id, { enabled: true });
  f.advance(60001);
  await f.service.requestCode(mobile);
  pending = f.service.loginWithCode(mobile, '123456');
  f.advance(60001);
  await f.service.requestCode(mobile);
  finish(true);
  await assert.rejects(pending, (e) => e.status === 401);
  assert.equal(f.store.db.prepare('SELECT COUNT(*) AS count FROM sessions').get().count, 0);
});

test('同一验证码并发远程验证，两次成功回复仅能签发一次会话', async (t) => {
  const callbacks = [];
  const f = fixture(t, () => new Promise((resolve) => { callbacks.push(resolve); }));
  await f.service.requestCode(mobile);
  const one = f.service.loginWithCode(mobile, '123456');
  const two = f.service.loginWithCode(mobile, '123456');
  const settled = Promise.allSettled([one, two]);
  callbacks[0](true); callbacks[1](true);
  const results = await settled;
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
  assert.equal(results.filter((r) => r.status === 'rejected').length, 1);
  assert.equal(f.store.db.prepare('SELECT COUNT(*) AS count FROM sessions').get().count, 1);
});

test('对外兼容两个 /api/sms 接口，真实模式不给 devCode；请求别名共用 IP 限流', async (t) => {
  const f = fixture(t);
  const server = createApp({ config: { ...config, production: false, databaseFile: f.store.path }, store: f.store,
    sendSms: async () => {}, verifySms: async ({ code }) => code === '123456', now: f.now });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  t.after(() => new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); }));
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = async (path, input) => fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input) });
  const sent = await post('/api/sms/requestCode', { number: mobile });
  assert.equal(sent.status, 200); assert.equal((await sent.json()).devCode, undefined);
  const login = await post('/api/sms/verifyCode', { phone: mobile, code: '123456' });
  assert.equal(login.status, 200); assert.match(login.headers.get('set-cookie'), /Max-Age=604800/);
  assert.equal((await login.json()).account.mobile, mobile);
  for (let i = 0; i < 19; i++) await post(i % 2 ? '/api/auth/code' : '/api/sms/requestCode', { mobile: 'bad', number: 'bad' });
  assert.equal((await post('/api/auth/code', { mobile: 'bad' })).status, 429);
});

test('远程配置必须有接口地址，HTTPS 或本机 HTTP 联调，验证码字段不能覆盖 phone', () => {
  assert.throws(() => loadConfig({ SMS_MODE: 'remote' }), /DEBUG_SMS_HOST/);
  assert.throws(() => loadConfig({ SMS_MODE: 'remote', DEBUG_SMS_HOST: 'http://sms.example.com' }), /HTTPS/);
  assert.throws(() => loadConfig({ SMS_MODE: 'remote', DEBUG_SMS_HOST: 'https://sms.example.com', SMS_VERIFY_CODE_FIELD: 'phone' }), /字段/);
  assert.equal(loadConfig({ SMS_MODE: 'remote', DEBUG_SMS_HOST: 'http://127.0.0.1:5555' }).smsMode, 'remote');
});
