const test = require('node:test')
const assert = require('node:assert/strict')
const { createServer } = require('node:http')
const { createManagementHandler } = require('./extras-management.cjs')
const config = { extrasHost: 'https://extras.test', managementToken: 'private-server-token', loginHost: 'https://login.test', appId: 'app', origin: 'http://127.0.0.1:3000' }
const proof = (appId = 'app') => JSON.stringify({ appKey: 'user', appId, date: new Date().toISOString(), sign: 'a'.repeat(64) })
async function fixture(t, role = 'admin', invalid = false, origin = config.origin, authProfiles = {}) {
  const calls = []
  const loginHosts = [config.loginHost, ...Object.values(authProfiles).map(profile => profile.loginHost)]
  const handler = createManagementHandler({ ...config, origin, authProfiles }, async (url, options) => {
    calls.push({ url, options })
    if (url.endsWith('/payment-screenshot')) return {ok:true,status:200,headers:new Headers({'content-type':'image/png','content-length':'8'}),arrayBuffer:async()=>new Uint8Array([137,80,78,71,13,10,26,10]).buffer}
    const value = loginHosts.some(host => url.startsWith(host + '/')) ? url.includes('/checkToken') ? { error: invalid } : { error: false, data: { id: 'verified-user', accountId: 'verified-operator', role, nickName: '真实审核人' } } : { order: { id: 'order-id' } }
    return { ok: true, status: 200, json: async () => value }
  })
  const server = createServer(async (req, res) => { if (!await handler(req, res)) { res.writeHead(404); res.end() } })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections() }))
  const base = `http://127.0.0.1:${server.address().port}/api/extras-management`
  const call = async (path, input, headers = {}) => {
    const result = await fetch(`http://127.0.0.1:${server.address().port}/api/extras-management${path}`, { method: input ? 'POST' : 'GET', headers: { 'X-Management-Auth': proof(), Origin: config.origin, ...(input ? { 'Content-Type': 'application/json' } : {}), ...headers }, body: input ? JSON.stringify(input) : undefined })
    return { status: result.status, value: await result.json() }
  }
  return { calls, call, base }
}
test('登录服务校验管理员、服务端注入密钥与审核人，浏览器伪造身份无效', async t => {
  const f = await fixture(t)
  const result = await f.call('/orders/order-id/review', { eventId: 'event', status: 'approved', reviewerName: '伪造用户' })
  assert.equal(result.status, 200)
  const forwarded = f.calls.find(call => call.url.startsWith(config.extrasHost))
  assert.equal(forwarded.options.headers.Authorization, 'Bearer private-server-token')
  assert.equal(JSON.parse(forwarded.options.body).reviewerName, '真实审核人')
  assert.equal(forwarded.options.headers.Cookie, undefined)
  assert.equal(JSON.stringify(result).includes(config.managementToken), false)
})
test('成员或过期登录不能读取或修改新管理功能，且不请求订单后台', async t => {
  for (const [role, expired, status] of [['member', false, 403], ['admin', true, 401]]) {
    const f = await fixture(t, role, expired)
    assert.equal((await f.call('/orders')).status, status)
    assert.equal(f.calls.some(call => call.url.startsWith(config.extrasHost)), false)
  }
})
test('履约确认只传已验证的接单人身份，发起退款仍需要管理权限', async t => {
  const refundId = '12345678-1234-1234-1234-123456789abc'
  const member = await fixture(t, 'member')
  const path = '/fulfillment-refunds/' + refundId + '/confirm'
  assert.equal((await member.call(path, { operatorId: '伪造', operatorName: '伪造', status: 'initiated' })).status, 200)
  assert.deepEqual(JSON.parse(member.calls.at(-1).options.body), { operatorId: 'verified-operator', operatorName: '真实审核人' })
  assert.equal((await member.call('/orders/order-id/refund-initiate', { refundId, eventId: 'event' })).status, 403)
  assert.equal(member.calls.filter(call => call.url.startsWith(config.extrasHost)).length, 1)
  const admin = await fixture(t)
  assert.equal((await admin.call('/orders/order-id/refund-initiate', { refundId, eventId: 'event', operatorName: '伪造' })).status, 200)
  assert.deepEqual(JSON.parse(admin.calls.at(-1).options.body), { refundId, eventId: 'event', operatorName: '真实审核人' })
})
test('跨站请求、过期签名、无关路径被拒绝；渠道请求保留幂等编号', async t => {
  const f = await fixture(t)
  assert.equal((await f.call('/orders/order-id/receipt', { amount: 100 }, { Origin: 'https://evil.test' })).status, 403)
  assert.equal((await f.call('/orders', undefined, { 'X-Management-Auth': JSON.stringify({ appKey: 'user', appId: 'app', date: '2000-01-01', sign: 'a'.repeat(64) }) })).status, 401)
  assert.equal((await f.call('/auth/login')).status, 404)
  assert.equal((await f.call('/channels', { name: '新渠道' }, { 'Idempotency-Key': 'create-channel-key-001' })).status, 200)
  const last = f.calls[f.calls.length - 1]
  assert.equal(last.url, 'https://extras.test/api/channel-management/channels')
  assert.equal(last.options.headers['Idempotency-Key'], 'create-channel-key-001')
})

test('付款截图仍要求管理员登录，二进制只转发给已鉴权请求',async t=>{
  const f=await fixture(t)
  const unauthorized=await fetch(f.base+'/orders/order-id/payment-screenshot')
  assert.equal(unauthorized.status,401)
  assert.equal(f.calls.length,0)
  const result=await fetch(f.base+'/orders/order-id/payment-screenshot',{headers:{'X-Management-Auth':proof()}})
  assert.equal(result.status,200);assert.equal(result.headers.get('content-type'),'image/png');assert.equal((await result.arrayBuffer()).byteLength,8)
  assert.equal(f.calls[f.calls.length-1].options.headers.Authorization,'Bearer private-server-token')
  assert.equal(result.headers.get('authorization'),null)
  const member=await fixture(t,'member');assert.equal((await fetch(member.base+'/orders/order-id/payment-screenshot',{headers:{'X-Management-Auth':proof()}})).status,403)
});


test('白名单跨域预检不调用上游，读取和写入继续校验登录签名', async t => {
  const origin = 'https://dev-admin.test'
  const f = await fixture(t, 'admin', false, config.origin + ',' + origin)
  const preflight = await fetch(f.base + '/orders/order-id/review', { method: 'OPTIONS', headers: {
    Origin: origin, 'Access-Control-Request-Method': 'POST',
    'Access-Control-Request-Headers': 'content-type, x-management-auth, idempotency-key',
  } })
  assert.equal(preflight.status, 204)
  assert.equal(preflight.headers.get('access-control-allow-origin'), origin)
  assert.equal(preflight.headers.get('access-control-allow-methods'), 'POST')
  assert.match(preflight.headers.get('access-control-allow-headers'), /X-Management-Auth/)
  assert.equal(preflight.headers.get('access-control-allow-credentials'), null)
  assert.match(preflight.headers.get('vary'), /Origin/)
  assert.equal(f.calls.length, 0)
  const unauthenticated = await fetch(f.base + '/orders', { headers: { Origin: origin } })
  assert.equal(unauthenticated.status, 401)
  assert.equal(unauthenticated.headers.get('access-control-allow-origin'), origin)
  assert.equal(f.calls.length, 0)
  const result = await f.call('/orders/order-id/review', { status: 'approved' }, { Origin: origin, 'Sec-Fetch-Site': 'cross-site' })
  assert.equal(result.status, 200)
  const forwarded = f.calls.find(call => call.url.startsWith(config.extrasHost))
  assert.equal(JSON.parse(forwarded.options.body).reviewerName, '真实审核人')
  assert.equal(forwarded.options.headers.Authorization, 'Bearer private-server-token')
  assert.equal(forwarded.options.headers.Origin, undefined)
})

test('预检拒绝未授权来源、路径、方法及请求头，不触达登录或订单服务', async t => {
  const origin = 'https://dev-admin.test'
  const f = await fixture(t, 'admin', false, origin)
  for (const [path, method, headers, source] of [
    ['/orders', 'GET', 'x-management-auth', 'https://evil.test'],
    ['/orders', 'GET', 'x-management-auth', origin + '.evil.test'],
    ['/orders', 'GET', 'x-management-auth', 'null'],
    ['/orders', 'DELETE', 'x-management-auth', origin],
    ['/auth/login', 'POST', 'content-type', origin],
    ['/orders', 'POST', 'authorization', origin],
  ]) {
    const result = await fetch(f.base + path, { method: 'OPTIONS', headers: {
      Origin: source, 'Access-Control-Request-Method': method, 'Access-Control-Request-Headers': headers,
    } })
    assert.equal(result.status, 403)
    if (source !== origin) assert.equal(result.headers.get('access-control-allow-origin'), null)
  }
  for (const path of ['/orders', '/orders/order-id/payment-screenshot']) {
    const result = await fetch(f.base + path, { headers: { Origin: 'https://evil.test', 'X-Management-Auth': proof() } })
    assert.equal(result.status, 403)
    assert.equal(result.headers.get('access-control-allow-origin'), null)
  }
  assert.equal(f.calls.length, 0)
})

test('跨域渠道PATCH和受保护图片保留CORS，图片和错误响应不暴露私有密钥', async t => {
  const origin = 'https://dev-admin.test'
  const f = await fixture(t, 'admin', false, origin)
  const patched = await fetch(f.base + '/accounts/account-id', { method: 'PATCH', headers: {
    Origin: origin, 'X-Management-Auth': proof(), 'Content-Type': 'application/json', 'Sec-Fetch-Site': 'cross-site',
  }, body: JSON.stringify({ enabled: false }) })
  assert.equal(patched.status, 200)
  assert.equal(patched.headers.get('access-control-allow-origin'), origin)
  const image = await fetch(f.base + '/orders/order-id/payment-screenshot', { headers: { Origin: origin, 'X-Management-Auth': proof() } })
  assert.equal(image.status, 200)
  assert.equal(image.headers.get('access-control-allow-origin'), origin)
  assert.equal(image.headers.get('access-control-allow-credentials'), null)
  assert.equal(image.headers.get('authorization'), null)
  assert.equal((await image.arrayBuffer()).byteLength, 8)
  const member = await fixture(t, 'member', false, origin)
  const denied = await fetch(member.base + '/orders', { headers: { Origin: origin, 'X-Management-Auth': proof() } })
  assert.equal(denied.status, 403)
  assert.equal(denied.headers.get('access-control-allow-origin'), origin)
  assert.equal(member.calls.some(call => call.url.startsWith(config.extrasHost)), false)
  assert.equal(JSON.stringify(await denied.json()).includes(config.managementToken), false)
})

test('无Origin写请求仍被拒绝；同源无Origin读取继续要求签名', async t => {
  const f = await fixture(t)
  const result = await fetch(f.base + '/orders/order-id/receipt', { method: 'POST', headers: {
    'X-Management-Auth': proof(), 'Content-Type': 'application/json',
  }, body: JSON.stringify({ amount: 100 }) })
  assert.equal(result.status, 403)
  assert.equal(f.calls.length, 0)
  const signed = await fetch(f.base + '/orders', { headers: { 'X-Management-Auth': proof() } })
  assert.equal(signed.status, 200)
  assert.equal(signed.headers.get('access-control-allow-origin'), null)
})

test('来源配置只接受精确HTTPS origin或本机HTTP，不允许通配、路径或账号密码', () => {
  for (const origin of ['*', 'https://dev-admin.test/', 'https://dev-admin.test/path', 'https://user:password@dev-admin.test', 'http://dev-admin.test']) {
    assert.throws(() => createManagementHandler({ ...config, origin }))
  }
})


const profileOrigin = 'https://dev-admin.test'
const legacyOrigin = 'https://192.0.2.10'
const profiles = { [profileOrigin]: { appId: 'dev-app', loginHost: 'https://dev-login.test' } }
const profileOrigins = legacyOrigin + ',' + profileOrigin

test('来源对应的登录应用使用各自可信服务校验，dev管理员仍由服务端注入私有密钥', async t => {
  const f = await fixture(t, 'admin', false, profileOrigins, profiles)
  const response = await fetch(f.base + '/orders', { headers: { Origin: profileOrigin, 'X-Management-Auth': proof('dev-app') } })
  assert.equal(response.status, 200)
  assert.equal(response.headers.get('access-control-allow-origin'), profileOrigin)
  const loginCalls = f.calls.filter(call => !call.url.startsWith(config.extrasHost))
  assert.equal(loginCalls.length, 2)
  assert.ok(loginCalls.every(call => call.url.startsWith('https://dev-login.test/')))
  assert.deepEqual(loginCalls.map(call => new URL(call.url).pathname), ['/checkToken', '/accountDetail'])
  assert.ok(loginCalls.every(call => new URL(call.url).searchParams.get('appId') === 'dev-app'))
  const forwarded = f.calls.find(call => call.url.startsWith(config.extrasHost))
  assert.equal(forwarded.options.headers.Authorization, 'Bearer ' + config.managementToken)
  assert.equal(forwarded.options.headers.Origin, undefined)
  assert.equal(JSON.stringify(await response.json()).includes(config.managementToken), false)
})

test('错误应用、未授权来源和无Origin的dev凭据均不能选择其他登录profile', async t => {
  const f = await fixture(t, 'admin', false, profileOrigins, profiles)
  for (const [origin, appId, status] of [
    [profileOrigin, 'app', 401],
    [legacyOrigin, 'dev-app', 401],
    ['https://unconfigured.test', 'dev-app', 403],
    [undefined, 'dev-app', 401],
  ]) {
    const response = await fetch(f.base + '/orders', { headers: {
      ...(origin ? { Origin: origin } : {}), 'X-Management-Auth': proof(appId),
    } })
    assert.equal(response.status, status)
  }
  assert.equal(f.calls.length, 0)
})

test('IP来源及无Origin读取保留原默认应用和登录服务', async t => {
  const f = await fixture(t, 'admin', false, profileOrigins, profiles)
  for (const origin of [legacyOrigin, undefined]) {
    const response = await fetch(f.base + '/orders', { headers: {
      ...(origin ? { Origin: origin } : {}), 'X-Management-Auth': proof(),
    } })
    assert.equal(response.status, 200)
    assert.equal(response.headers.get('access-control-allow-origin'), origin || null)
  }
  const loginCalls = f.calls.filter(call => !call.url.startsWith(config.extrasHost))
  assert.equal(loginCalls.length, 4)
  assert.ok(loginCalls.every(call => call.url.startsWith(config.loginHost + '/')))
  assert.ok(loginCalls.every(call => new URL(call.url).searchParams.get('appId') === 'app'))
})

test('dev来源的member和guest仍不能读取订单或修改渠道', async t => {
  for (const role of ['member', 'guest']) {
    const f = await fixture(t, role, false, profileOrigins, profiles)
    const headers = { Origin: profileOrigin, 'X-Management-Auth': proof('dev-app') }
    const read = await fetch(f.base + '/orders', { headers })
    assert.equal(read.status, 403)
    assert.equal(read.headers.get('access-control-allow-origin'), profileOrigin)
    const write = await fetch(f.base + '/channels', { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify({ name: '未授权渠道' }) })
    assert.equal(write.status, 403)
    assert.equal(f.calls.some(call => call.url.startsWith(config.extrasHost)), false)
    assert.ok(f.calls.every(call => call.url.startsWith('https://dev-login.test/')))
  }
})

test('请求中的profile覆盖字段不能替换可信登录服务或应用', async t => {
  const f = await fixture(t, 'admin', false, profileOrigins, profiles)
  const query = new URLSearchParams({ loginHost: 'https://untrusted-login.test', appId: 'app', authProfile: 'default' })
  const response = await fetch(f.base + '/orders?' + query, { headers: {
    Origin: profileOrigin, 'X-Management-Auth': proof('dev-app'),
    'X-Management-Login-Host': 'https://untrusted-login.test', 'X-Management-App-Id': 'app',
  } })
  assert.equal(response.status, 200)
  const loginCalls = f.calls.filter(call => !call.url.startsWith(config.extrasHost))
  assert.equal(loginCalls.length, 2)
  assert.ok(loginCalls.every(call => call.url.startsWith('https://dev-login.test/')))
  assert.ok(loginCalls.every(call => new URL(call.url).searchParams.get('appId') === 'dev-app'))
  assert.equal(f.calls.some(call => call.url.startsWith('https://untrusted-login.test')), false)
})

test('登录profile必须属于来源白名单并提供固定HTTPS服务和非空应用', () => {
  const valid = { ...config, origin: profileOrigins }
  assert.throws(() => createManagementHandler({ ...config, authProfiles: profiles }))
  for (const loginHost of ['http://untrusted-login.test', 'https://user:password@login.test', 'https://login.test/?token=value', 'https://login.test/#part']) {
    assert.throws(() => createManagementHandler({ ...valid, authProfiles: { [profileOrigin]: { appId: 'dev-app', loginHost } } }))
  }
  assert.throws(() => createManagementHandler({ ...valid, authProfiles: { [profileOrigin]: { appId: '', loginHost: 'https://dev-login.test' } } }))
})


test('退回付款资料路由只允许已鉴权管理员，真实退回人员由服务端写入', async t => {
  const origin = 'https://admin.test'
  const f = await fixture(t, 'admin', false, origin)
  const path = '/orders/order-id/reject-payment'
  const preflight = await fetch(f.base + path, { method: 'OPTIONS', headers: {
    Origin: origin, 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'content-type,x-management-auth',
  } })
  assert.equal(preflight.status, 204)
  assert.equal(preflight.headers.get('access-control-allow-origin'), origin)
  assert.equal(f.calls.length, 0)
  const input = { eventId: 'reject-event', noteId: 'current-note', reason: '付款截图与流水不符', reviewerName: '伪造人员', rejectedAt: Date.now() }
  const response = await f.call(path, input, { Origin: origin })
  assert.equal(response.status, 200)
  const forwarded = f.calls.find(call => call.url.startsWith(config.extrasHost))
  assert.equal(forwarded.url, config.extrasHost + '/api/order-management' + path)
  assert.deepEqual(JSON.parse(forwarded.options.body), { ...input, reviewerName: '真实审核人' })
  assert.equal(forwarded.options.headers.Authorization, 'Bearer ' + config.managementToken)
  for (const [role, invalid, status] of [['member', false, 403], ['admin', true, 401]]) {
    const denied = await fixture(t, role, invalid, origin)
    assert.equal((await denied.call(path, input, { Origin: origin })).status, status)
    assert.equal(denied.calls.some(call => call.url.startsWith(config.extrasHost)), false)
  }
  const before = f.calls.length
  assert.equal((await f.call(path, input, { Origin: 'https://admin.test.untrusted.invalid' })).status, 403)
  assert.equal(f.calls.length, before)
  const unsigned = await fetch(f.base + path, { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify(input) })
  assert.equal(unsigned.status, 401)
  assert.equal(unsigned.headers.get('access-control-allow-origin'), origin)
  assert.equal(f.calls.length, before)
})


test('报价接口受管理员登录和来源保护，报价人取自已认证身份', async t => {
  const path = '/orders/order-id/quote'
  const input = { eventId: 'quote-event', amount: 2580, note: '同城配送报价', quotedBy: '伪造身份' }
  const f = await fixture(t)
  const preflight = await fetch(f.base + path, { method: 'OPTIONS', headers: {
    Origin: config.origin, 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'content-type,x-management-auth',
  } })
  assert.equal(preflight.status, 204)
  assert.equal(preflight.headers.get('access-control-allow-origin'), config.origin)
  assert.equal(f.calls.length, 0)
  const result = await f.call(path, input)
  assert.equal(result.status, 200)
  const forwarded = f.calls.find(call => call.url.startsWith(config.extrasHost))
  assert.equal(forwarded.url, config.extrasHost + '/api/order-management' + path)
  assert.equal(forwarded.options.headers.Authorization, 'Bearer ' + config.managementToken)
  assert.deepEqual(JSON.parse(forwarded.options.body), { ...input, quotedBy: '真实审核人' })
  const before = f.calls.length
  assert.equal((await f.call(path, input, { Origin: 'https://evil.test' })).status, 403)
  const unsigned = await fetch(f.base + path, { method: 'POST', headers: { Origin: config.origin, 'Content-Type': 'application/json' }, body: JSON.stringify(input) })
  assert.equal(unsigned.status, 401)
  assert.equal(f.calls.length, before)
  const member = await fixture(t, 'member')
  assert.equal((await member.call(path, input)).status, 403)
  assert.equal(member.calls.some(call => call.url.startsWith(config.extrasHost)), false)
})
