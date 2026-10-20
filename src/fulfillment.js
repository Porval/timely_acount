import { createHash } from 'node:crypto';

export function signParams(input, key, secret, now = Date.now) {
  const params = { ...input, appKey: key, date: new Date(now()).toISOString() };
  const source = Object.keys(params).sort().map(name => `${name}=${params[name]}`).join('&') + secret;
  return { ...params, sign: createHash('sha256').update(source).digest('hex').toLowerCase() };
}
export function createFulfillmentClient(config, fetchImpl = fetch, now = Date.now) {
  if (!config.timelyHost || !config.timelyKey || !config.timelySecret || !config.timelyService || !config.timelyCreator) return null;
  const url = new URL('admin/timelyOrders/', config.timelyHost.endsWith('/') ? config.timelyHost : `${config.timelyHost}/`).href;
  const client = async (order, jobId) => {
    if ([order.cityId, order.brandId, order.plateId].some(id => id.startsWith('preview-'))) throw new Error('示例目录订单不能发送到履约系统，请配置真实城市、品牌与平台');
    if (config.timelyPlatform && order.plateId !== config.timelyPlatform) throw new Error('订单平台与配置的平台服务商不匹配');
    const data = signParams({ cityId: order.cityId, brandId: order.brandId, plateFormId: order.plateId,
      items: JSON.stringify(order.items.map(({ imageUrl, ...item }) => item)), contacts: order.contacts, messages: order.messages, referenceId: order.referenceId || order.id,
      payPrice: order.payPrice / 100, arrivedTime: order.arrivedTime, orderPrice: 0, shopName: order.providerName,
      creatorId: config.timelyCreator, plateFormServerId: config.timelyService }, config.timelyKey, config.timelySecret, now);
    const response = await fetchImpl(url, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': jobId },
      body: JSON.stringify(data), redirect: 'error', signal: AbortSignal.timeout(10000) });
    if (!response.ok) throw new Error('履约建单接口请求失败');
    const payload = await response.json();
    const entity = payload?.data || payload;
    if (!payload || payload.error || !entity || !['string', 'number'].includes(typeof entity.id) || !String(entity.id).trim()) throw new Error('履约建单接口未返回有效订单 ID');
    return String(entity.id);
  };
  const get = async (path, params = {}) => {
    const target = new URL(path, config.timelyHost.endsWith('/') ? config.timelyHost : `${config.timelyHost}/`);
    for (const [key, value] of Object.entries(signParams(params, config.timelyKey, config.timelySecret, now))) target.searchParams.set(key, String(value));
    const response = await fetchImpl(target, { redirect: 'error', signal: AbortSignal.timeout(10000) });
    if (!response.ok) throw new Error('履约系统查询失败');
    const body = await response.json(); if (body?.error) throw new Error('履约系统返回异常'); return body?.data || body;
  };
  client.query = id => get(`admin/order/${encodeURIComponent(id)}`);
  client.options = async () => {
    const rows = await Promise.all(['cities','brands','plateForms'].map(path => get(`admin/${path}/`, {pageSize:0,...(path === 'brands' ? {locked:true} : {})})));
    const normalize = data => { if (!Array.isArray(data)) throw new Error('履约目录响应异常'); return data.filter(row => row.id !== undefined && typeof row.name === 'string').map(row => ({id:String(row.id),name:row.name})); };
    const platforms = normalize(rows[2]).filter(row => !config.timelyPlatform || row.id === config.timelyPlatform);
    if (!platforms.length) throw new Error('履约平台目录中未找到配置的平台');
    return { cities: normalize(rows[0]), brands: normalize(rows[1]), platforms, demo: false };
  };
  return client;
}

export class FulfillmentDispatcher {
  constructor(orders, client, { allowRetry = false, onCreated } = {}) { this.onCreated = onCreated; this.orders = orders; this.db = orders.db; this.client = client; this.allowRetry = allowRetry; this.busy = false; this.closed = false; }
  start() { if (this.client) { this.timer = setInterval(() => this.runOnce(), 5000); this.timer.unref(); this.runOnce(); } }
  async runOnce() {
    if (!this.client || this.busy || this.closed) return;
    this.busy = true;
    let job;
    try {
      job = this.orders.store.transaction(() => {
        const now = this.orders.now();
        if (!this.allowRetry) {
          for (const stale of this.db.prepare("SELECT * FROM fulfillment_jobs WHERE status='sending' AND lease_until<=?").all(now)) {
            const order = this.orders.get(stale.order_id);
            order.external = {status:'attention',message:'建单请求在重启前未确认结果，需要管理端核对。'};
            this.orders.store.write(order,now);
            this.db.prepare("UPDATE fulfillment_jobs SET status='retry',next_attempt_at=?,lease_until=0 WHERE id=?").run(Number.MAX_SAFE_INTEGER,stale.id);
          }
        }
        const row = this.db.prepare("SELECT * FROM fulfillment_jobs WHERE (status IN ('pending','retry') AND next_attempt_at<=?) OR (status='sending' AND lease_until<=?) ORDER BY created_at LIMIT 1").get(now, now);
        if (!row) return null;
        const order = this.orders.get(row.order_id);
        if (order.payment.status !== 'paid' || order.review.status !== 'approved') throw new Error('未审核订单不能建单');
        this.db.prepare("UPDATE fulfillment_jobs SET status='sending', attempts=attempts+1, lease_until=?, updated_at=? WHERE id=?").run(now + 30000, now, row.id);
        order.external = { status: 'creating' }; this.orders.store.write(order, now);
        return row;
      });
      if (!job) return;
      const id = await this.client(this.orders.get(job.order_id), job.id);
      this.orders.store.transaction(() => {
        const order = this.orders.get(job.order_id);
        if (order.external.timelyOrderId && order.external.timelyOrderId !== id) throw new Error('该订单已关联其他履约订单');
        order.external = { status: 'created', timelyOrderId: id, createdAt: this.orders.now() };
        order.fulfillment = { status: 'waiting', updatedAt: this.orders.now() };
        this.orders.event(order, '履约订单创建成功', `关联履约订单 ${id}，等待接单。`);
        this.orders.store.write(order, this.orders.now());
        this.db.prepare("UPDATE fulfillment_jobs SET status='created', lease_until=0, last_error=NULL, updated_at=? WHERE id=?").run(this.orders.now(), job.id);
      });
      if (this.onCreated) await this.onCreated(job.order_id);
    } catch (error) {
      if (job) this.orders.store.transaction(() => {
        const order = this.orders.get(job.order_id);
        if (order.external.status === 'created') return;
        order.external = { status: this.allowRetry ? 'retry' : 'attention', message: this.allowRetry ? '履约建单暂未成功，后台将重试。' : '履约建单结果未确认，需要管理端核对。' };
        this.orders.store.write(order, this.orders.now());
        this.db.prepare("UPDATE fulfillment_jobs SET status=?, lease_until=0, next_attempt_at=?, last_error=?, updated_at=? WHERE id=?")
          .run('retry', this.allowRetry ? this.orders.now() + Math.min(300000, 10000 * 2 ** Math.min(job.attempts, 5)) : Number.MAX_SAFE_INTEGER, '履约建单未完成', this.orders.now(), job.id);
      });
      console.error('履约建单未确认，任务已保留供管理端核对。');
    } finally { this.busy = false; }
  }
  async close() { this.closed = true; clearInterval(this.timer); while (this.busy) await new Promise(resolve => setTimeout(resolve, 10)); }
}
