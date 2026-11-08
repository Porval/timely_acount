const { createServer } = require('node:http')

class HttpError extends Error { constructor(status, message) { super(message); this.status = status } }
const send = (res, status, value) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' }); res.end(JSON.stringify(value)) }
function hostUrl(value, label) {
  if (!value) return null
  const url = new URL(value)
  if ((url.protocol !== 'https:' && !(url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname))) || url.username || url.password || url.search || url.hash) throw new Error(label + ' 必须是 HTTPS 基础地址，本机可用 HTTP')
  return url.href.replace(/\/$/, '')
}
function settings(env = process.env) {
  return {
    extrasHost: hostUrl(env.EXTRAS_ACCOUNT_HOST, 'EXTRAS_ACCOUNT_HOST'),
    managementToken: env.EXTRAS_ACCOUNT_MANAGEMENT_TOKEN,
    loginHost: hostUrl(env.EXTRAS_MANAGEMENT_LOGIN_HOST || env.REACT_APP_LOGIN_HOST, 'EXTRAS_MANAGEMENT_LOGIN_HOST'),
    appId: env.EXTRAS_MANAGEMENT_APP_ID || env.WX_OPEN_APP_ID,
    origin: env.EXTRAS_MANAGEMENT_ORIGIN,
    authProfiles: JSON.parse(env.EXTRAS_MANAGEMENT_AUTH_PROFILES || '{}'),
  }
}
function originAllowlist(value) {
  return new Set(String(value || '').split(',').map(item => item.trim()).filter(Boolean).map(item => {
    const url = new URL(item)
    const localHttp = url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
    if (url.origin !== item || (url.protocol !== 'https:' && !localHttp)) throw new Error('EXTRAS_MANAGEMENT_ORIGIN 必须是 HTTPS origin，本机联调可用 HTTP；多个来源用逗号分隔')
    return item
  }))
}
function loginProfiles(config, origins) {
  const configured = config.authProfiles || {}
  if (typeof configured !== 'object' || Array.isArray(configured)) throw new Error('EXTRAS_MANAGEMENT_AUTH_PROFILES 必须是按来源配置的 JSON 对象')
  return new Map(Object.entries(configured).map(([origin, profile]) => {
    if (!origins.has(origin)) throw new Error('登录配置来源必须在 EXTRAS_MANAGEMENT_ORIGIN 白名单中')
    if (!profile || typeof profile !== 'object' || Array.isArray(profile) || typeof profile.appId !== 'string' || !profile.appId.trim() || profile.appId.length > 120 || /\s/.test(profile.appId)) throw new Error('登录配置必须包含有效 appId')
    const loginHost = hostUrl(profile.loginHost, '登录配置 loginHost')
    if (!loginHost) throw new Error('登录配置必须包含可信 loginHost')
    return [origin, { appId: profile.appId, loginHost }]
  }))
}
async function jsonRequest(fetchImpl, url, options) {
  const result = await fetchImpl(url, { ...options, redirect: 'error', signal: AbortSignal.timeout(12000) })
  let value
  try { value = await result.json() } catch { throw new HttpError(502, '上游接口未返回 JSON') }
  return { status: result.status, ok: result.ok, value }
}
async function readBody(req) {
  if (!(req.headers['content-type'] || '').toLowerCase().startsWith('application/json')) throw new HttpError(415, '请使用 application/json')
  if (req.body && typeof req.body === 'object' && !Array.isArray(req.body)) {
    if (Buffer.byteLength(JSON.stringify(req.body)) > 65536) throw new HttpError(413, '请求内容过大')
    return req.body
  }
  let data = ''
  for await (const part of req) { data += part; if (Buffer.byteLength(data) > 65536) throw new HttpError(413, '请求内容过大') }
  try { const value = JSON.parse(data); if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(); return value } catch { throw new HttpError(400, 'JSON 格式不正确') }
}
async function authenticate(req, config, fetchImpl, requireAdmin) {
  const raw = req.headers['x-management-auth']
  if (typeof raw !== 'string' || raw.length > 2048) throw new HttpError(401, '请登录及时达管理端')
  let proof
  try { proof = JSON.parse(raw) } catch { throw new HttpError(401, '登录凭据格式不正确') }
  const age = Date.now() - Date.parse(proof.date)
  if (typeof proof.appKey !== 'string' || proof.appKey.length > 120 || !proof.appKey || proof.appId !== config.appId || typeof proof.sign !== 'string' || !/^[a-f0-9]{64}$/.test(proof.sign) || !Number.isFinite(age) || age < -30000 || age > 300000) throw new HttpError(401, '登录凭据已过期或不正确')
  const params = new URLSearchParams({ appKey: proof.appKey, appId: proof.appId, date: proof.date, sign: proof.sign })
  const check = await jsonRequest(fetchImpl, config.loginHost + '/checkToken?' + params, { method: 'GET' })
  if (!check.ok || !check.value || check.value.error) throw new HttpError(401, '管理端登录已失效')
  const result = await jsonRequest(fetchImpl, config.loginHost + '/accountDetail?' + params, { method: 'GET' })
  if (!result.ok || !result.value || result.value.error || !result.value.data || typeof result.value.data.id !== 'string') throw new HttpError(401, '管理端登录已失效')
  const account = result.value.data
  if (requireAdmin && !['admin', 'dev'].includes(account.role)) throw new HttpError(403, '仅管理员可管理服务商订单、渠道和账号')
  if (typeof account.nickName !== 'string' || !account.nickName.trim()) throw new HttpError(403, '缺少审核人员身份')
  return account
}
function route(path, method) {
  if (/^\/fulfillment-refunds\/[a-f0-9-]{36}\/confirm$/.test(path) && method === 'POST') return '/api/order-management' + path
  if (/^\/orders\/[A-Za-z0-9_-]{1,120}\/payment-screenshot$/.test(path) && method === 'GET') return '/api/order-management' + path
  if (path === '/orders' && method === 'GET') return '/api/order-management/orders'
  if (/^\/orders\/[A-Za-z0-9_-]{1,120}$/.test(path) && method === 'GET') return '/api/order-management' + path
  if (/^\/orders\/[A-Za-z0-9_-]{1,120}\/(quote|receipt|reject-payment|review|link|refund-mark|refund-initiate)$/.test(path) && method === 'POST') return '/api/order-management' + path
  if (['/channels', '/accounts'].includes(path) && ['GET', 'POST'].includes(method)) return '/api/channel-management' + path
  if (/^\/(channels|accounts)\/[A-Za-z0-9_-]{1,120}$/.test(path) && method === 'PATCH') return '/api/channel-management' + path
  return null
}
function createManagementHandler(config = settings(), fetchImpl = fetch) {
  const prefix = '/api/extras-management'
  const origins = originAllowlist(config.origin)
  const profiles = loginProfiles(config, origins)
  const preflightHeaders = new Set(['x-management-auth', 'content-type', 'idempotency-key'])
  return async (req, res, next) => {
    const url = new URL(req.originalUrl || req.url, 'http://localhost')
    if (url.pathname !== prefix && !url.pathname.startsWith(prefix + '/')) { if (next) next(); return false }
    res.setHeader('Vary', 'Origin')
    try {
      const origin = req.headers.origin
      const allowed = typeof origin === 'string' && origins.has(origin)
      if (origin !== undefined && !allowed) throw new HttpError(403, '请求来源不允许')
      // Authentication uses a signed header, never cross-site cookies. Keep
      // these headers on JSON errors and protected image responses as well.
      if (allowed) res.setHeader('Access-Control-Allow-Origin', origin)
      // Origin selects a server-configured login application. Never accept a
      // login host from the browser or choose a profile from an unverified appId.
      const authConfig = allowed && profiles.has(origin) ? profiles.get(origin) : config
      if (!config.extrasHost || !config.managementToken || !authConfig.loginHost || !authConfig.appId || !origins.size) throw new HttpError(503, '服务商管理接口尚未配置，请配置管理端服务器连接信息')
      const path = url.pathname.slice(prefix.length)
      if (req.method === 'OPTIONS') {
        if (!allowed) throw new HttpError(403, '请求来源不允许')
        const method = req.headers['access-control-request-method']
        const requested = String(req.headers['access-control-request-headers'] || '').split(',').map(value => value.trim().toLowerCase()).filter(Boolean)
        if (!['GET', 'POST', 'PATCH'].includes(method) || !route(path, method) || requested.some(value => !preflightHeaders.has(value))) throw new HttpError(403, '预检请求不允许')
        res.writeHead(204, { 'Access-Control-Allow-Methods': method, 'Access-Control-Allow-Headers': 'X-Management-Auth, Content-Type, Idempotency-Key', 'Access-Control-Max-Age': '600', 'Vary': 'Origin, Access-Control-Request-Method, Access-Control-Request-Headers', 'Cache-Control': 'no-store' })
        res.end()
        return true
      }
      const endpoint = route(path, req.method)
      if (!endpoint) throw new HttpError(404, '服务商管理接口不存在')
      if (req.method !== 'GET' && !allowed) throw new HttpError(403, '请求来源不允许')
      const fulfillmentConfirmation = path.startsWith('/fulfillment-refunds/')
      const account = await authenticate(req, authConfig, fetchImpl, !fulfillmentConfirmation)
      if (endpoint.endsWith('/payment-screenshot')) {
        const response=await fetchImpl(config.extrasHost+endpoint,{method:'GET',headers:{Authorization:'Bearer '+config.managementToken},redirect:'error',signal:AbortSignal.timeout(12000)})
        if(!response.ok)throw new HttpError(response.status,'付款截图读取失败')
        const type=(response.headers.get('content-type')||'').split(';')[0]
        if(!['image/png','image/jpeg','image/webp'].includes(type)||Number(response.headers.get('content-length'))>5*1024*1024)throw new HttpError(502,'付款截图响应异常')
        const data=Buffer.from(await response.arrayBuffer())
        if(!data.length||data.length>5*1024*1024)throw new HttpError(502,'付款截图响应异常')
        res.writeHead(200,{'Content-Type':type,'Content-Length':data.length,'Content-Disposition':'inline','Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff'});res.end(data)
        return true
      }
      let input
      if (req.method !== 'GET') {
        input = await readBody(req)
        if (endpoint.endsWith('/review') || endpoint.endsWith('/reject-payment')) input.reviewerName = account.nickName
        if (endpoint.endsWith('/quote')) input.quotedBy = account.nickName
        if (endpoint.endsWith('/refund-mark') || endpoint.endsWith('/refund-initiate')) {
          input = { refundId: input.refundId, eventId: input.eventId, operatorName: account.nickName }
        }
        if (fulfillmentConfirmation) {
          if (typeof account.accountId !== 'string' || !account.accountId.trim() || account.accountId.length > 120) throw new HttpError(403, '缺少履约人员身份')
          input = { operatorId: account.accountId, operatorName: account.nickName }
        }
      }
      const key = req.headers['idempotency-key']
      if (key !== undefined && (typeof key !== 'string' || !/^[A-Za-z0-9_-]{16,120}$/.test(key))) throw new HttpError(400, '请求编号不正确')
      const result = await jsonRequest(fetchImpl, config.extrasHost + endpoint + url.search, {
        method: req.method, headers: { Authorization: 'Bearer ' + config.managementToken, ...(input ? { 'Content-Type': 'application/json' } : {}), ...(key ? { 'Idempotency-Key': key } : {}) },
        body: input ? JSON.stringify(input) : undefined,
      })
      send(res, result.status, result.value)
    } catch (error) { send(res, error.status || 502, { error: error.status ? error.message : '管理接口暂时不可用，请刷新确认结果后重试' }) }
    return true
  }
}
module.exports = { createManagementHandler, settings }
if (require.main === module) {
  const handler = createManagementHandler()
  const server = createServer(async (req, res) => { if (!await handler(req, res)) send(res, 404, { error: '接口不存在' }) })
  server.requestTimeout = 15000
  server.listen(Number(process.env.EXTRAS_MANAGEMENT_PORT || 3101), process.env.EXTRAS_MANAGEMENT_BIND || '127.0.0.1', () => console.log('服务商管理接口服务已启动'))
}
