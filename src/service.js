import { createHash, randomBytes, randomInt, randomUUID, timingSafeEqual } from 'node:crypto';
import { SESSION_TTL, OTP_TTL } from './config.js';
import { resolveChannel } from './channel-service.js';

export class AppError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
const fail = (status, message) => { throw new AppError(status, message); };
const hash = (value) => createHash('sha256').update(value).digest('hex');
const equal = (a, b) => typeof a === 'string' && typeof b === 'string' && a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
export function mobileValue(value) {
  if (typeof value !== 'string' || !/^1[3-9]\d{9}$/.test(value.trim())) fail(400, '请输入有效的中国大陆 11 位手机号');
  return value.trim();
}
function textValue(value, label) {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > 80) fail(400, `${label}需填写 1 到 80 个字符`);
  return value.trim();
}
export const publicAccount = ({ id, providerName, personName, mobile, role, enabled, createdAt, updatedAt, channelId, channelEnabled }) =>
  ({ id, providerName, personName, mobile, role, enabled, createdAt, updatedAt, channelId, channelEnabled });

export class AccountService {
  constructor({ store, sendSms, verifySms, now = Date.now }) { this.store = store; this.sendSms = sendSms; this.verifySms = verifySms; this.now = now; }
  createAccount(input) {
    const mobile = mobileValue(input.mobile);
    const personName = textValue(input.personName, '人员名称');
    const role = input.role ?? 'member';
    if (!['admin', 'member'].includes(role)) fail(400, '角色不正确');
    const now = this.now();
    return this.store.update((state) => {
      if (state.accounts.some((a) => a.mobile === mobile)) fail(409, '手机号已存在');
      const channel = resolveChannel(this.store.db, input, now);
      const account = { id: randomUUID(), providerName: channel.name, channelId: channel.id, channelEnabled: true, personName, mobile, role, enabled: true, createdAt: now, updatedAt: now, session: null };
      state.accounts.push(account);
      return publicAccount(account);
    });
  }
  listAccounts() { return this.store.read().accounts.map(publicAccount); }
  updateAccount(id, input) {
    return this.store.update((state) => {
      const account = state.accounts.find((a) => a.id === id);
      if (!account) fail(404, '账户不存在');
      const next = { ...account };
      if ((input.channelId !== undefined && input.channelId !== account.channelId) || input.providerName !== undefined) {
        const channel = resolveChannel(this.store.db, input, this.now());
        next.providerName = channel.name; next.channelId = channel.id; next.channelEnabled = true;
      }
      if (input.personName !== undefined) next.personName = textValue(input.personName, '人员名称');
      if (input.mobile !== undefined) next.mobile = mobileValue(input.mobile);
      if (input.role !== undefined) {
        if (!['admin', 'member'].includes(input.role)) fail(400, '角色不正确');
        next.role = input.role;
      }
      if (input.enabled !== undefined) {
        if (typeof input.enabled !== 'boolean') fail(400, '启用状态不正确');
        next.enabled = input.enabled;
      }
      if (state.accounts.some((a) => a.id !== id && a.mobile === next.mobile)) fail(409, '手机号已存在');
      if (account.enabled && account.role === 'admin' && (!next.enabled || next.role !== 'admin') &&
          !state.accounts.some((a) => a.id !== id && a.enabled && a.role === 'admin')) fail(409, '至少保留一名启用的管理员');
      if (next.mobile !== account.mobile || next.role !== account.role || next.channelId !== account.channelId || !next.enabled) {
        next.session = null;
        delete state.challenges[account.mobile];
        delete state.challenges[next.mobile];
      }
      next.updatedAt = this.now();
      Object.assign(account, next);
      return publicAccount(account);
    });
  }
  async requestCode(value) {
    const mobile = mobileValue(value);
    const now = this.now();
    const code = this.verifySms ? undefined : String(randomInt(0, 1000000)).padStart(6, '0');
    const salt = randomBytes(16).toString('hex');
    let accountExists = false;
    this.store.update((state) => {
      for (const [number, challenge] of Object.entries(state.challenges)) {
        if (challenge.expiresAt <= now) delete state.challenges[number];
      }
      for (const [number, times] of Object.entries(state.deliveries)) {
        state.deliveries[number] = times.filter((time) => now - time < 3600000);
        if (!state.deliveries[number].length) delete state.deliveries[number];
      }
      const times = state.deliveries[mobile] || [];
      if (times.length && now - times.at(-1) < 60000) fail(429, '请等待 60 秒后再获取验证码');
      if (times.length >= 10) fail(429, '验证码请求过于频繁，请稍后重试');
      state.deliveries[mobile] = [...times, now];
      accountExists = state.accounts.some((a) => a.enabled && a.channelEnabled !== false && a.mobile === mobile);
      if (accountExists) state.challenges[mobile] = { hash: hash(salt + (code || 'remote')), salt, expiresAt: now + OTP_TTL, attempts: 0 };
    });
    if (!accountExists) return {};
    try { await this.sendSms({ mobile, code }); }
    catch (error) {
      this.store.update((state) => {
        if (state.challenges[mobile]?.salt === salt) delete state.challenges[mobile];
      });
      if (error instanceof AppError) throw error;
      fail(502, '短信发送失败，请稍后重试');
    }
    return this.verifySms ? {} : { code };
  }
  async loginWithCode(value, code) {
    if (!this.verifySms) return this.login(value, code);
    const mobile = mobileValue(value);
    if (typeof code !== 'string' || !/^\d{6}$/.test(code)) fail(400, '请输入 6 位验证码');
    const salt = this.store.update((state) => {
      const challenge = state.challenges[mobile];
      const account = state.accounts.find((a) => a.mobile === mobile && a.enabled && a.channelEnabled !== false);
      if (!challenge || challenge.expiresAt <= this.now() || !account) {
        delete state.challenges[mobile];
        return null;
      }
      if (challenge.attempts >= 5) return null;
      challenge.attempts++;
      return challenge.salt;
    });
    if (!salt) fail(401, '验证码无效或已过期，请重新获取');
    let verified = false;
    try { verified = await this.verifySms({ mobile, code }); }
    catch (error) {
      this.clearExhaustedChallenge(mobile, salt);
      if (error instanceof AppError) throw error;
      fail(502, '短信验证接口暂不可用，请稍后重试');
    }
    if (verified !== true) {
      this.clearExhaustedChallenge(mobile, salt);
      fail(401, '验证码无效或已过期，请重新获取');
    }
    const result = this.store.update((state) => {
      const challenge = state.challenges[mobile];
      const account = state.accounts.find((a) => a.mobile === mobile && a.enabled && a.channelEnabled !== false);
      if (!challenge || challenge.salt !== salt || challenge.expiresAt <= this.now() || !account) return null;
      delete state.challenges[mobile];
      return this.issueSession(account);
    });
    if (!result) fail(401, '验证码已使用、已更新或账户状态已改变，请重新获取');
    return result;
  }
  clearExhaustedChallenge(mobile, salt) {
    this.store.update((state) => {
      if (state.challenges[mobile]?.salt === salt && state.challenges[mobile].attempts >= 5) delete state.challenges[mobile];
    });
  }
  issueSession(account) {
    const token = randomBytes(32).toString('base64url');
    account.session = { tokenHash: hash(token), expiresAt: this.now() + SESSION_TTL };
    return { account: publicAccount(account), token, expiresAt: account.session.expiresAt };
  }
  login(value, code) {
    if (this.verifySms) fail(500, '远程验证码必须通过登录校验入口');
    const mobile = mobileValue(value);
    if (typeof code !== 'string' || !/^\d{6}$/.test(code)) fail(400, '请输入 6 位验证码');
    const now = this.now();
    const result = this.store.update((state) => {
      const challenge = state.challenges[mobile];
      const account = state.accounts.find((a) => a.mobile === mobile && a.enabled && a.channelEnabled !== false);
      if (!challenge || challenge.expiresAt <= now || !account) {
        delete state.challenges[mobile];
        return null;
      }
      challenge.attempts++;
      if (!equal(challenge.hash, hash(challenge.salt + code))) {
        if (challenge.attempts >= 5) delete state.challenges[mobile];
        return null;
      }
      delete state.challenges[mobile];
      return this.issueSession(account);
    });
    if (!result) fail(401, '验证码无效或已过期，请重新获取');
    return result;
  }
  authenticate(token) {
    if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(token)) fail(401, '请重新登录');
    const digest = hash(token);
    const account = this.store.read().accounts.find((a) => a.enabled && a.channelEnabled !== false && a.session && equal(a.session.tokenHash, digest) && a.session.expiresAt > this.now());
    if (!account) fail(401, '登录已过期或已在其他设备登录，请重新登录');
    return { ...publicAccount(account), expiresAt: account.session.expiresAt };
  }
  logout(token) {
    const account = this.authenticate(token);
    this.store.update((state) => {
      const current = state.accounts.find((a) => a.id === account.id);
      if (current.session?.tokenHash === hash(token)) current.session = null;
    });
  }
}
