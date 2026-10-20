import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SQLiteStore } from '../src/store.js';
import { AccountService } from '../src/service.js';
import { ChannelService } from '../src/channel-service.js';
import { OrderService } from '../src/order-service.js';
import { createApp } from '../src/server.js';

const managementToken = 'channel-management-server-test-token-12345';
function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'extras-channels-test-'));
  const store = new SQLiteStore(join(dir, 'accounts.sqlite'));
  let time = Date.now();
  const accounts = new AccountService({ store, sendSms: async () => {}, now: () => time });
  const channels = new ChannelService(store, accounts, () => time);
  t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });
  return { dir, store, accounts, channels, advance: value => { time += value; } };
}
test('渠道账号持久化、创建幂等、手机号唯一与成员身份限制', t => {
  const f = fixture(t);
  const first = f.channels.create({ name: '服务商 A' }, 'channel-create-key-001');
  assert.equal(first.created, true);
  assert.equal(f.channels.create({ name: '服务商 A' }, 'channel-create-key-001').created, false);
  assert.throws(() => f.channels.create({ name: '其他渠道' }, 'channel-create-key-001'), /其他内容/);
  assert.throws(() => f.channels.create({ name: '服务商 A' }, 'channel-create-key-002'), /已存在/);
  const input = { channelId: first.channel.id, personName: '渠道人员', mobile: '13800138000' };
  const created = f.channels.createAccount(input, 'account-create-key-001');
  assert.equal(created.account.role, 'member'); assert.equal(created.account.providerName, '服务商 A'); assert.equal(created.account.channelId, first.channel.id);
  assert.equal(f.channels.createAccount(input, 'account-create-key-001').account.id, created.account.id);
  assert.throws(() => f.channels.createAccount(input, 'account-create-key-002'), /手机号已存在/);
  assert.throws(() => f.channels.createAccount({ ...input, role: 'admin', mobile: '13900139000' }, 'account-create-key-003'), /成员身份/);
  assert.equal(f.channels.get(first.channel.id).accountCount, 1);
  const reopened = new SQLiteStore(f.store.path); t.after(() => reopened.close());
  assert.equal(reopened.read().accounts[0].channelId, first.channel.id);
});
test('旧账号按服务商归入渠道，原会话与历史订单归属保留', t => {
  const f = fixture(t);
  const account = f.accounts.createAccount({ providerName: '原服务商', personName: '原人员', mobile: '13800138000' });
  const order = new OrderService(f.store).create(account, { cityId: 'city', cityName: '上海', brandId: 'brand', brandName: '品牌', plateId: 'plate', platformName: '平台', items: [{ itemName: '商品', spec: '', salesPrice: 100, quantity: 1 }], contacts: '收件信息', referenceId: 'old-reference', payPrice: 100, arrivedTime: 30 }, 'old-create-key').order;
  f.store.db.prepare('DELETE FROM account_channels').run();
  const session = f.store.update(state => f.accounts.issueSession(state.accounts[0]));
  const reopened = new SQLiteStore(f.store.path); t.after(() => reopened.close());
  const service = new AccountService({ store: reopened });
  assert.equal(service.authenticate(session.token).id, account.id);
  assert.ok(service.authenticate(session.token).channelId);
  const channels = new ChannelService(reopened, service);
  const channel = channels.list().channels[0];
  channels.update(channel.id, { name: '更名服务商' });
  assert.equal(service.authenticate(session.token).providerName, '更名服务商');
  assert.equal(new OrderService(reopened).get(order.id).providerName, '原服务商');
  assert.equal(new OrderService(reopened).get(order.id).ownerId, account.id);
});
test('渠道停用立即撤销会话和验证码，保留账号状态，重新启用后需重新登录', async t => {
  const f = fixture(t); const channel = f.channels.create({ name: '渠道' }, 'channel-create-key-001').channel;
  const account = f.channels.createAccount({ channelId: channel.id, personName: '人员', mobile: '13800138000' }, 'account-create-key-001').account;
  const challenge = await f.accounts.requestCode(account.mobile); const session = f.accounts.login(account.mobile, challenge.code);
  f.channels.update(channel.id, { enabled: false });
  assert.throws(() => f.accounts.authenticate(session.token), /重新登录/);
  assert.equal(f.accounts.listAccounts()[0].enabled, true);
  assert.equal(f.accounts.listAccounts()[0].channelEnabled, false);
  f.advance(60001);
  assert.deepEqual(await f.accounts.requestCode(account.mobile), {});
  assert.throws(() => f.channels.createAccount({ channelId: channel.id, personName: '其他人员', mobile: '13900139000' }, 'account-create-key-002'), /渠道已停用/);
  f.channels.update(channel.id, { enabled: true });
  assert.throws(() => f.accounts.authenticate(session.token), /重新登录/);
});
test('账号换渠道、停用会撤销登录，管理员不能通过渠道账号接口编辑', async t => {
  const f = fixture(t);
  const account = f.accounts.createAccount({ providerName: 'A', personName: '人员', mobile: '13800138000' });
  const channel = f.channels.create({ name: 'B' }, 'channel-create-key-001').channel;
  const code = await f.accounts.requestCode(account.mobile); const session = f.accounts.login(account.mobile, code.code);
  f.channels.updateAccount(account.id, { channelId: channel.id });
  assert.equal(f.accounts.listAccounts()[0].providerName, 'B'); assert.throws(() => f.accounts.authenticate(session.token), /重新登录/);
  f.channels.updateAccount(account.id, { enabled: false });
  assert.equal(f.channels.listAccounts({ channelId: channel.id, search: '1380' }).total, 1);
  const admin = f.accounts.createAccount({ providerName: '管理员', personName: '管理员', mobile: '13900139000', role: 'admin' });
  assert.throws(() => f.channels.updateAccount(admin.id, { enabled: false }), /成员账号/);
  assert.throws(() => f.channels.update(admin.channelId, { enabled: false }), /后台管理员/);
});
test('管理端渠道接口必须持有服务端鉴权，不能用成员登录或指定管理员角色', async t => {
  const f = fixture(t);
  const server = createApp({ store: f.store, config: { smsMode: 'console', managementToken }, sendSms: async () => {} });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const base = `http://127.0.0.1:${server.address().port}/api/channel-management`;
  const call = async (path, input, method = 'POST', authenticated = true) => {
    const result = await fetch(base + path, { method, headers: { ...(authenticated ? { Authorization: `Bearer ${managementToken}` } : {}), 'Content-Type': 'application/json', 'Idempotency-Key': 'http-channel-key-001' }, body: input ? JSON.stringify(input) : undefined });
    return { status: result.status, body: await result.json() };
  };
  assert.equal((await call('/channels', { name: 'HTTP渠道' }, 'POST', false)).status, 401);
  const channel = await call('/channels', { name: 'HTTP渠道' }); assert.equal(channel.status, 201);
  assert.equal((await call('/channels', { name: 'HTTP渠道' })).status, 200);
  assert.equal((await call('/accounts', { channelId: channel.body.channel.id, personName: '人员', mobile: '13800138000', role: 'admin' })).status, 400);
  assert.equal((await call('/channels', undefined, 'GET')).body.channels.length, 1);
});
