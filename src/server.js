import { createHash, timingSafeEqual } from 'node:crypto';
import { OrderService } from './order-service.js';
import { ChannelService } from './channel-service.js';
import { FulfillmentDispatcher, createFulfillmentClient } from './fulfillment.js';
import { FulfillmentSynchronizer } from './fulfillment-sync.js';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { ROOT, loadConfig, SESSION_TTL } from './config.js';
import { SQLiteStore } from './store.js';
import { AccountService, AppError } from './service.js';
import { createSmsSender, createSmsVerifier } from './sms.js';
import { sendScreenshot } from './payment-screenshot.js';
import { createCatalogClient } from './catalog.js';

const assets = new Map([['/', ['index.html', 'text/html']], ['/app.js', ['app.js', 'text/javascript']], ['/style.css', ['style.css', 'text/css']]]);
const json = (response, status, body) => {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(body));
};
async function body(request, limit = 16384) {
  if (!(request.headers['content-type'] || '').toLowerCase().startsWith('application/json')) throw new AppError(415, '请求需使用 application/json');
  let data = '';
  for await (const chunk of request) {
    data += chunk.toString();
    if (Buffer.byteLength(data) > limit) throw new AppError(413, '请求内容过大');
  }
  try {
    const parsed = JSON.parse(data);
    if (!parsed || Array.isArray(parsed) || typeof parsed !== 'object') throw new Error();
    return parsed;
  } catch { throw new AppError(400, 'JSON 格式不正确'); }
}
function cookieToken(request) {
  const entry = (request.headers.cookie || '').split(';').map((x) => x.trim()).find((x) => x.startsWith('account_session='));
  return entry?.slice('account_session='.length);
}
function setSession(response, token, expiresAt, config) {
  response.setHeader('Set-Cookie', `account_session=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${token ? SESSION_TTL / 1000 : 0}; Expires=${new Date(expiresAt).toUTCString()}${config.production ? '; Secure' : ''}`);
}
export function createApp({ config = loadConfig(), store = new SQLiteStore(config.databaseFile, { legacyFile: config.legacyFile }), sendSms = createSmsSender(config), verifySms = createSmsVerifier(config), now = Date.now, fulfillmentClient, catalogClient } = {}) {
  const service = new AccountService({ store, sendSms, verifySms, now });
  const orders = new OrderService(store, now);
  const searchProducts = catalogClient || createCatalogClient(config);
  const channels = new ChannelService(store, service, now);
  const timely = fulfillmentClient ?? createFulfillmentClient(config, fetch, now);
  const synchronizer = new FulfillmentSynchronizer(orders, timely);
  const dispatcher = new FulfillmentDispatcher(orders, timely, { allowRetry: config.timelyIdempotency === true, onCreated:id=>synchronizer.refresh(id,{force:true}) });
  const rate = new Map();
  const server = createServer(async (request, response) => {
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('X-Frame-Options', 'DENY');
    response.setHeader('Referrer-Policy', 'same-origin');
    response.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    if (config.production) response.setHeader('Strict-Transport-Security', 'max-age=31536000');
    try {
      const url = new URL(request.url, 'http://localhost');
      const path = url.pathname;
      if (config.smsMode === 'console') {
        const hostname = new URL(`http://${request.headers.host}`).hostname;
        if (!['127.0.0.1', 'localhost', '[::1]'].includes(hostname)) throw new AppError(403, '开发服务仅允许本机域名访问');
      }
      if (!['GET', 'POST', 'PATCH'].includes(request.method)) throw new AppError(405, '请求方法不支持');
      if (request.method !== 'GET') {
        const origin = request.headers.origin;
        const allowed = config.origin || `http://${request.headers.host}`;
        if ((origin && origin !== allowed) || request.headers['sec-fetch-site'] === 'cross-site') throw new AppError(403, '请求来源不允许');
      }
      if (request.method === 'GET' && assets.has(path)) {
        const [file, type] = assets.get(path);
        response.writeHead(200, { 'Content-Type': `${type}; charset=utf-8` });
        response.end(readFileSync(resolve(ROOT, 'public', file)));
        return;
      }
      if (request.method === 'GET' && path === '/api/health') return json(response, 200, { status: 'ok', service: 'extras-account' });
      if (request.method === 'GET' && path === '/api/config') return json(response, 200, { developmentSms: config.smsMode === 'console' && !config.production });
      if (request.method === 'POST' && ['/api/auth/code', '/api/auth/login', '/api/sms/requestCode', '/api/sms/verifyCode'].includes(path)) {
        const requestCode = ['/api/auth/code', '/api/sms/requestCode'].includes(path);
        const key = `${request.socket.remoteAddress}:${requestCode ? 'code' : 'login'}`;
        const time = now();
        for (const [name, item] of rate) if (item.reset <= time) rate.delete(name);
        if (!rate.has(key) && rate.size >= 10000) throw new AppError(429, '请求过于频繁');
        const item = rate.get(key) || { count: 0, reset: time + 600000 };
        item.count++;
        rate.set(key, item);
        if (item.count > (requestCode ? 20 : 60)) throw new AppError(429, '请求过于频繁，请稍后重试');
        const input = await body(request);
        const mobile = path === '/api/sms/requestCode' ? input.number : path === '/api/sms/verifyCode' ? input.phone : input.mobile;
        if (requestCode) {
          const result = await service.requestCode(mobile);
          const loopback = ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(request.socket.remoteAddress);
          const dev = config.smsMode === 'console' && !config.production && loopback;
          return json(response, 200, { message: '若手机号对应已启用账户，验证码将发送至该手机', retryAfter: 60, ...(dev && result.code ? { devCode: result.code } : {}) });
        }
        const code = path === '/api/sms/verifyCode' ? input[config.smsCodeField || 'code'] : input.code;
        const result = await service.loginWithCode(mobile, code);
        setSession(response, result.token, result.expiresAt, config);
        return json(response, 200, { account: result.account, expiresAt: result.expiresAt });
      }
      if (path.startsWith('/api/order-management/') || path.startsWith('/api/channel-management/')) {
        if (!config.managementToken) throw new AppError(503, '管理端订单接口尚未配置鉴权');
        const supplied = (request.headers.authorization || '').replace(/^Bearer /, '');
        const hash = value => createHash('sha256').update(value).digest();
        if (!request.headers.authorization?.startsWith('Bearer ') || !timingSafeEqual(hash(supplied), hash(config.managementToken))) throw new AppError(401, '管理端鉴权失败');
        if (path.startsWith('/api/channel-management/')) {
          const base = '/api/channel-management';
          const channelMatch = path.match(/^\/api\/channel-management\/channels\/([^/]+)$/);
          const accountMatch = path.match(/^\/api\/channel-management\/accounts\/([^/]+)$/);
          if (request.method === 'GET' && path === base + '/channels') return json(response, 200, channels.list());
          if (request.method === 'POST' && path === base + '/channels') {
            const result = channels.create(await body(request), request.headers['idempotency-key']);
            return json(response, result.created ? 201 : 200, result);
          }
          if (request.method === 'PATCH' && channelMatch) return json(response, 200, channels.update(channelMatch[1], await body(request)));
          if (request.method === 'GET' && path === base + '/accounts') return json(response, 200, channels.listAccounts(Object.fromEntries(url.searchParams)));
          if (request.method === 'POST' && path === base + '/accounts') {
            const result = channels.createAccount(await body(request), request.headers['idempotency-key']);
            return json(response, result.created ? 201 : 200, result);
          }
          if (request.method === 'PATCH' && accountMatch) return json(response, 200, channels.updateAccount(accountMatch[1], await body(request)));
          throw new AppError(404, '渠道管理接口不存在');
        }
        const match = path.match(/^\/api\/order-management\/orders\/([^/]+)(?:\/(receipt|review|fulfillment|link|payment-screenshot))?$/);
        if (request.method === 'GET' && path === '/api/order-management/orders') return json(response, 200, orders.list(null, Object.fromEntries(url.searchParams)));
        if (match && request.method === 'GET' && match[2] === 'payment-screenshot') return sendScreenshot(response, orders.getPaymentScreenshot(match[1]));
        if (match && request.method === 'GET' && !match[2]) {
          let order = orders.get(match[1]);
          order = await synchronizer.refresh(order.id);
          return json(response, 200, { order });
        }
        if (match && request.method === 'POST' && ['receipt','review','fulfillment','link'].includes(match[2])) {
          const result = orders[match[2]](match[1], await body(request, 65536));
          if (match[2] === 'review') queueMicrotask(() => dispatcher.runOnce());
          return json(response, 200, result);
        }
        throw new AppError(404, '管理端订单接口不存在');
      }
      if (path === '/api/products' && request.method === 'GET') {
        service.authenticate(cookieToken(request));
        return json(response, 200, await searchProducts(Object.fromEntries(url.searchParams)));
      }
      if (path === '/api/order-options') {
        service.authenticate(cookieToken(request));
        if (request.method !== 'GET') throw new AppError(405, '请求方法不支持');
        if (timely?.options) return json(response, 200, await timely.options());
        return json(response, 200, { demo: true, cities: [{id:'preview-shanghai',name:'上海'},{id:'preview-hangzhou',name:'杭州'}], brands:[{id:'preview-brand',name:'示例品牌'}], platforms:[{id:'preview-meituan',name:'美团'},{id:'preview-eleme',name:'饿了么'},{id:'preview-other',name:'其他'}] });
      }
      if (path === '/api/orders' || /^\/api\/orders\/[^/]+(?:\/(?:manual-payment|payment-screenshot))?$/.test(path)) {
        const account = service.authenticate(cookieToken(request));
        if (request.method === 'GET' && path.endsWith('/payment-screenshot')) return sendScreenshot(response, orders.getPaymentScreenshot(path.split('/').at(-2), account.id));
        if (request.method === 'POST' && path.endsWith('/manual-payment')) return json(response, 200, orders.submitManualPayment(path.split('/').at(-2), account, await body(request, 8 * 1024 * 1024)));
        if (request.method === 'GET' && path === '/api/orders') return json(response, 200, orders.list(account.id, Object.fromEntries(url.searchParams)));
        if (request.method === 'POST' && path === '/api/orders') {
          const result = orders.create(account, await body(request, 65536), request.headers['idempotency-key']);
          return json(response, result.created ? 201 : 200, result);
        }
        if (request.method === 'GET') {
          let order = orders.get(path.split('/').at(-1), account.id);
          order = await synchronizer.refresh(order.id);
          return json(response, 200, { order });
        }
        throw new AppError(405, '发起方只能创建和查询订单');
      }
      if (!['/api/auth/me', '/api/auth/logout', '/api/accounts'].includes(path) && !/^\/api\/accounts\/[^/]+$/.test(path)) throw new AppError(404, '接口不存在');
      const token = cookieToken(request);
      const account = service.authenticate(token);
      if (request.method === 'GET' && path === '/api/auth/me') return json(response, 200, { account, expiresAt: account.expiresAt });
      if (request.method === 'POST' && path === '/api/auth/logout') {
        service.logout(token);
        setSession(response, '', 0, config);
        return json(response, 200, { message: '已退出登录' });
      }
      if (account.role !== 'admin') throw new AppError(403, '只有管理员可以管理账户');
      if (request.method === 'GET' && path === '/api/accounts') return json(response, 200, { accounts: service.listAccounts() });
      if (request.method === 'POST' && path === '/api/accounts') return json(response, 201, { account: service.createAccount(await body(request)) });
      if (request.method === 'PATCH' && /^\/api\/accounts\/[^/]+$/.test(path)) return json(response, 200, { account: service.updateAccount(path.split('/').at(-1), await body(request)) });
      throw new AppError(404, '接口不存在');
    } catch (error) {
      if (!(error instanceof AppError)) console.error('请求处理失败', error.message);
      if (!response.headersSent) json(response, error.status || 500, { error: error.status ? error.message : '服务异常，请稍后重试' });
      else response.end();
    }
  });
  server.on('listening', () => { dispatcher.start(); synchronizer.start(); });
  server.on('close', () => { Promise.all([dispatcher.close(),synchronizer.close()]).then(() => store.close()); });
  server.requestTimeout = 15000;
  server.headersTimeout = 10000;
  return server;
}
