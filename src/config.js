import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const SESSION_TTL = 7 * 24 * 60 * 60 * 1000;
export const OTP_TTL = 5 * 60 * 1000;
export function loadConfig(env = process.env) {
  const production = env.NODE_ENV === 'production';
  const mode = env.SMS_MODE || (production ? 'remote' : 'console');
  if (!['console', 'remote'].includes(mode)) throw new Error('SMS_MODE 仅支持 console 或 remote');
  const port = Number(env.PORT || 3100);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT 必须是 1 到 65535 的整数');
  const host = env.HOST || '127.0.0.1';
  if (mode === 'console' && (production || !['127.0.0.1', '::1', 'localhost'].includes(host))) {
    throw new Error('开发验证码模式仅允许非生产环境的本机服务');
  }
  if (mode === 'remote') {
    let endpoint;
    try { endpoint = new URL(env.DEBUG_SMS_HOST); }
    catch { throw new Error('请配置短信接口地址 DEBUG_SMS_HOST'); }
    const localHttp = !production && endpoint.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(endpoint.hostname);
    if (endpoint.protocol !== 'https:' && !localHttp) throw new Error('短信接口必须使用 HTTPS，本机联调可使用 HTTP');
    if (endpoint.username || endpoint.password || endpoint.search || endpoint.hash) throw new Error('短信基础地址不能包含账号密码、查询参数或片段');
  }
  const phoneField = env.SMS_VERIFY_PHONE_FIELD || 'phone';
  if (!['phone', 'number'].includes(phoneField)) throw new Error('短信手机号字段仅支持 phone 或 number');
  const codeField = env.SMS_VERIFY_CODE_FIELD || 'code';
  if (!/^[A-Za-z][A-Za-z0-9_]{0,31}$/.test(codeField) || ['phone', 'number', '__proto__', 'constructor', 'prototype'].includes(codeField)) throw new Error('短信验证码字段名称不正确');
  if (production && !env.APP_ORIGIN) throw new Error('生产环境必须配置 APP_ORIGIN');
  if (env.APP_ORIGIN && production && new URL(env.APP_ORIGIN).protocol !== 'https:') throw new Error('生产 APP_ORIGIN 必须使用 HTTPS');
  if (env.ORDER_MANAGEMENT_TOKEN && !/^[A-Za-z0-9_-]{32,256}$/.test(env.ORDER_MANAGEMENT_TOKEN)) throw new Error('管理端密钥需为至少 32 位的字母数字字符串');
  const timelyHost = env.TIMELY_ORDER_HOST;
  if (env.STANDARD_ITEM_HOST) {
    const target = new URL(env.STANDARD_ITEM_HOST);
    if ((target.protocol !== 'https:' && !(target.protocol === 'http:' && ['127.0.0.1','localhost','[::1]'].includes(target.hostname) && !production)) || target.username || target.password || target.search || target.hash) throw new Error('商品库地址需为 HTTPS 基础地址');
  }
  if (timelyHost) {
    const target = new URL(timelyHost);
    const localHttp = !production && target.protocol === 'http:' && ['127.0.0.1','localhost','[::1]'].includes(target.hostname);
    if ((target.protocol !== 'https:' && !localHttp) || target.username || target.password || target.search || target.hash) throw new Error('履约系统地址需为 HTTPS 基础地址，本机联调可用 HTTP');
  }
  return { standardHost:env.STANDARD_ITEM_HOST, standardKey:env.STANDARD_ITEM_KEY, standardSecret:env.STANDARD_ITEM_SECRET, timelyIdempotency: env.TIMELY_IDEMPOTENCY_SUPPORTED === 'true', managementToken: env.ORDER_MANAGEMENT_TOKEN, timelyHost, timelyKey: env.TIMELY_ORDER_KEY, timelySecret: env.TIMELY_ORDER_SECRET,
    timelyPlatform: env.TIMELY_PLATFORM_ID, timelyService: env.TIMELY_ORDER_SERVICE, timelyCreator: env.TIMELY_CREATOR_ID, host, port, production, smsMode: mode, smsHost: env.DEBUG_SMS_HOST, smsTemplate: env.DEBUG_SMS_TEM, smsCodeField: codeField, smsPhoneField: phoneField,
    smsToken: env.SMS_API_TOKEN, origin: env.APP_ORIGIN,
    databaseFile: resolve(ROOT, env.DATABASE_FILE || 'data/accounts.sqlite'),
    legacyFile: resolve(ROOT, env.DATA_FILE || 'data/accounts.json') };
}
