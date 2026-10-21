import { createHash, randomUUID } from 'node:crypto';
import { AppError } from './service.js';
import { OrderStore } from './order-store.js';
import { parseScreenshot } from './payment-screenshot.js';
import { fulfillmentSnapshot } from './fulfillment-snapshot.js';

const fail = (status, message) => { throw new AppError(status, message); };
const text = (value, label, max = 100, optional = false) => {
  if (optional && (value === undefined || value === '')) return '';
  if (typeof value !== 'string' || !value.trim() || value.trim().length > max) fail(400, `${label}不正确`);
  return value.trim();
};
const imageSnapshot = (value) => {
  if (value === undefined || value === '') return {};
  const source = text(value, '商品图片地址', 2048);
  try {
    const url = new URL(source);
    if (url.protocol === 'https:' && !url.username && !url.password) return { imageUrl: url.href };
  } catch {}
  fail(400, '商品图片地址必须是有效的 HTTPS 链接');
};
const integer = (value, label, min, max) => {
  if (!Number.isSafeInteger(value) || value < min || value > max) fail(400, `${label}不正确`);
  return value;
};
const digest = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export function stage(order) {
  if (order.payment.status === 'submitted') return '待收款确认';
  if (order.payment.status !== 'paid') return '待付款';
  if (order.review.status === 'rejected') return '审核未通过';
  if (order.review.status !== 'approved') return '已收款待审核';
  if (order.external.status !== 'created') return '审核通过待建单';
  if (order.fulfillment.sourceCode === 6) return '已退款';
  if (order.fulfillment.sourceCode === 8 || order.fulfillment.errorOrder) return '履约异常';
  if (order.fulfillment.hungup) return '已挂起';
  if (order.fulfillment.status === 'delivered') return '已完成';
  return order.fulfillment.status === 'waiting' ? '待履约' : '履约中';
}
function validateOrder(input) {
  if (!Array.isArray(input.items) || !input.items.length || input.items.length > 50) fail(400, '请填写 1 至 50 件商品');
  return {
    cityId: text(input.cityId, '城市 ID'), cityName: text(input.cityName, '城市', 80),
    brandId: text(input.brandId, '品牌 ID'), brandName: text(input.brandName, '品牌', 80),
    plateId: text(input.plateId, '平台 ID'), platformName: text(input.platformName, '平台', 80),
    items: input.items.map(item => ({ itemName: text(item.itemName, '商品名称', 120), spec: text(item.spec, '规格', 120, true),
      salesPrice: integer(item.salesPrice, '商品单价（分）', 1, 99999999), quantity: integer(item.quantity, '商品数量', 1, 9999), ...(item.upc ? {upc:text(item.upc,'UPC',80)} : {}), ...(item.catalogId ? {catalogId:text(item.catalogId,'商品库 ID',120)} : {}), ...imageSnapshot(item.imageUrl) })),
    contacts: text(input.contacts, '收件信息', 1000), messages: text(input.messages, '备注', 1000, true),
    referenceId: text(typeof input.referenceId === 'string' ? input.referenceId.trim() : input.referenceId, '外部订单号', 100, true), payPrice: integer(input.payPrice, '应付金额（分）', 1, 99999999),
    arrivedTime: integer(input.arrivedTime, '送达时限', 1, 1440),
  };
}
export class OrderService {
  constructor(accountStore, now = Date.now) { this.store = new OrderStore(accountStore); this.db = this.store.db; this.now = now; }
  event(order, title, description) { order.events.push({ id: randomUUID(), time: this.now(), title, description }); }
  get(id, ownerId) {
    const order = this.store.read(id);
    if (!order || (ownerId && order.ownerId !== ownerId)) fail(404, '订单不存在');
    return order;
  }
  list(ownerId, query = {}) {
    const page = integer(Number(query.page || 1), '页码', 1, 100000);
    const pageSize = integer(Number(query.pageSize || 20), '每页数量', 1, 100);
    const reviewStatus = query.reviewStatus;
    if (reviewStatus && !['not_submitted', 'pending', 'approved', 'rejected'].includes(reviewStatus)) fail(400, '审核筛选状态不正确');
    const filters = []; const params = [];
    if (ownerId) { filters.push('owner_id=?'); params.push(ownerId); }
    if (reviewStatus) { filters.push("json_extract(data,'$.review.status')=?"); params.push(reviewStatus); }
    for (const [field, expression] of [['contacts',"json_extract(data,'$.contacts')"], ['reference','reference_id']]) {
      if (query[field]) { const value = text(query[field], '筛选条件', 1000); filters.push(`instr(lower(${expression}),lower(?))>0`); params.push(value); }
    }
    if (query.item) { filters.push("EXISTS (SELECT 1 FROM json_each(json_extract(data,'$.items')) WHERE instr(lower(json_extract(value,'$.itemName') || ' ' || coalesce(json_extract(value,'$.spec'),'')),lower(?))>0)"); params.push(text(query.item,'商品筛选',120)); }
    if (query.date) { if (!/^\d{4}-\d{2}-\d{2}$/.test(query.date)) fail(400,'日期筛选格式不正确'); filters.push("date(created_at/1000,'unixepoch','+8 hours')=?"); params.push(query.date); }
    if (query.stage) {
      if (!['待付款','待收款确认','已收款待审核','审核未通过','审核通过待建单','待履约','履约中','已完成','已退款','履约异常','已挂起'].includes(query.stage)) fail(400,'进度筛选不正确');
      filters.push("CASE WHEN json_extract(data,'$.payment.status')='submitted' THEN '待收款确认' WHEN json_extract(data,'$.payment.status')!='paid' THEN '待付款' WHEN json_extract(data,'$.review.status')='rejected' THEN '审核未通过' WHEN json_extract(data,'$.review.status')!='approved' THEN '已收款待审核' WHEN json_extract(data,'$.external.status')!='created' THEN '审核通过待建单' WHEN json_extract(data,'$.fulfillment.sourceCode')=6 THEN '已退款' WHEN json_extract(data,'$.fulfillment.sourceCode')=8 OR json_extract(data,'$.fulfillment.errorOrder')=1 THEN '履约异常' WHEN json_extract(data,'$.fulfillment.hungup')=1 THEN '已挂起' WHEN json_extract(data,'$.fulfillment.status')='delivered' THEN '已完成' WHEN json_extract(data,'$.fulfillment.status')='waiting' THEN '待履约' ELSE '履约中' END=?"); params.push(query.stage);
    }
    const where = filters.length ? `WHERE ${filters.join(' AND ')}` : '';
    const total = this.db.prepare(`SELECT count(*) AS total FROM orders ${where}`).get(...params).total;
    const orders = this.db.prepare(`SELECT data FROM orders ${where} ORDER BY created_at DESC, rowid DESC LIMIT ? OFFSET ?`)
      .all(...params, pageSize, (page - 1) * pageSize).map(row => JSON.parse(row.data));
    return { orders, total, page, pageSize };
  }
  create(account, input, createKey) {
    const payload = validateOrder(input); const key = text(createKey, 'Idempotency-Key', 120); const hash = digest(payload);
    return this.store.transaction(() => {
      const existing = this.db.prepare('SELECT id, create_hash FROM orders WHERE owner_id=? AND create_key=?').get(account.id, key);
      if (existing) {
        if (existing.create_hash !== hash) fail(409, '同一建单请求编号对应不同内容');
        return { order: this.get(existing.id), created: false };
      }
      if (payload.referenceId && this.db.prepare('SELECT 1 FROM orders WHERE owner_id=? AND reference_id=?').get(account.id, payload.referenceId)) fail(409, '外部订单号已存在');
      const now = this.now();
      const order = { ...payload, id: randomUUID(), ownerId: account.id, operatorName: account.personName, providerName: account.providerName,
        createdAt: now, payment: { status: 'unpaid' }, review: { status: 'not_submitted' }, external: { status: 'not_created' },
        fulfillment: { status: 'not_started' }, events: [] };
      this.event(order, '手工创建订单', `${account.providerName} · ${account.personName} 创建订单，等待收款。`);
      this.db.prepare('INSERT INTO orders(id,owner_id,reference_id,create_key,create_hash,data,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)')
        .run(order.id, account.id, order.referenceId || null, key, hash, JSON.stringify(order), now, now);
      return { order, created: true };
    });
  }
  getPaymentScreenshot(id, ownerId) {
    const order = this.get(id, ownerId);
    const screenshot = this.db.prepare('SELECT * FROM payment_screenshots WHERE id=? AND order_id=?').get(order.payment.screenshot?.id || '', id);
    if (!screenshot) fail(404, '付款截图不存在');
    return screenshot;
  }
  submitManualPayment(id, account, input) {
    const payload = { reference: text(input.reference, '付款流水号', 120), description: text(input.description, '付款说明', 1000, true) };
    const previousNoteId = input.previousNoteId === undefined ? undefined : text(input.previousNoteId, 'previousNoteId', 120);
    return this.store.transaction(() => {
      const order = this.get(id, account.id);
      if (order.payment.status === 'paid') fail(409, '已确认收款，不能重复提交付款信息');
      const hasRejections = Boolean(order.payment.rejections?.length);
      if (hasRejections) {
        const expected = order.payment.status === 'submitted' ? order.payment.previousNoteId : order.payment.noteId;
        if (!previousNoteId || previousNoteId !== expected) fail(409, '付款资料已更新，请刷新订单后重新提交');
      } else if (previousNoteId !== undefined) fail(409, '付款资料版本不匹配，请刷新订单后重新提交');
      const image = parseScreenshot(input.screenshot);
      if (order.payment.status === 'submitted' && (order.payment.reference !== payload.reference || order.payment.description !== payload.description || (order.payment.screenshot && order.payment.screenshot.sha256 !== image.sha256))) fail(409, '已提交付款信息，等待管理端核对');
      if (order.payment.status === 'submitted' && order.payment.screenshot) return { order, replayed: true };
      const now = this.now();
      const screenshot = {id:randomUUID(),contentType:image.contentType,size:image.size,sha256:image.sha256,uploadedAt:now};
      this.db.prepare('INSERT INTO payment_screenshots(id,order_id,content_type,sha256,data,created_at) VALUES(?,?,?,?,?,?)').run(screenshot.id,id,image.contentType,image.sha256,image.data,now);
      const supplement = order.payment.status === 'submitted';
      order.payment = { ...order.payment, status: 'submitted', noteId: supplement ? order.payment.noteId || randomUUID() : randomUUID(), ...payload, screenshot,
        submittedAt: supplement ? order.payment.submittedAt || now : now, payerId: account.id, payerName: account.personName,
        ...(hasRejections ? { previousNoteId } : {}) };
      delete order.payment.rejection;
      this.event(order, supplement ? '补充付款截图' : hasRejections ? '重新提交付款资料' : '提交手动付款信息', `${account.personName} 提交付款流水和截图，等待管理端核对到账。`);
      this.store.write(order, now);
      return { order, replayed: false };
    });
  }
  rejectPayment(id, input) {
    const payload = { noteId: text(input.noteId, '付款资料编号', 120), reason: text(input.reason, '退回原因', 1000),
      reviewerName: text(input.reviewerName, '核对人员', 80), rejectedAt: this.timestamp(input.rejectedAt, '退回时间') };
    return this.receive(id, 'reject-payment', input.eventId, payload, order => {
      if (order.payment.status !== 'submitted' || order.payment.noteId !== payload.noteId) fail(409, '付款资料已更新或不在待收款确认状态，请刷新订单');
      if (payload.rejectedAt < order.payment.submittedAt) fail(409, '退回时间不能早于付款资料提交时间');
      if (order.review.status !== 'not_submitted' || order.external.status !== 'not_created') fail(409, '订单已经进入收款审核流程，不能退回付款资料');
      const previous = order.payment;
      const rejected = { ...payload, reference: previous.reference, description: previous.description, screenshot: previous.screenshot,
        submittedAt: previous.submittedAt, payerId: previous.payerId, payerName: previous.payerName };
      order.payment = { ...previous, status: 'unpaid', rejection: payload, rejections: [...(previous.rejections || []), rejected] };
      this.event(order, '付款资料已退回', `${payload.reviewerName}：${payload.reason}`);
    });
  }
  timestamp(value, label) { return integer(value, label, 1, this.now() + 300000); }
  receive(id, type, eventId, payload, apply) {
    const event = text(eventId, 'eventId', 120); const hash = digest(payload);
    return this.store.transaction(() => {
      const existing = this.db.prepare('SELECT * FROM management_events WHERE event_id=?').get(event);
      if (existing) {
        if (existing.order_id !== id || existing.type !== type || existing.payload_hash !== hash) fail(409, 'eventId 已用于其他内容');
        return { order: this.get(id), replayed: true };
      }
      const order = this.get(id); apply(order);
      this.store.write(order, this.now());
      this.db.prepare('INSERT INTO management_events(event_id,order_id,type,payload_hash,received_at) VALUES(?,?,?,?,?)')
        .run(event, id, type, hash, this.now());
      return { order, replayed: false };
    });
  }
  receipt(id, input) {
    const payload = { transactionId: text(input.transactionId, '收款流水号', 120), amount: integer(input.amount, '收款金额（分）', 1, 99999999),
      collectedAt: this.timestamp(input.collectedAt, '收款时间'), ...(input.noteId === undefined ? {} : { noteId: text(input.noteId, '付款资料编号', 120) }) };
    return this.receive(id, 'receipt', input.eventId, payload, order => {
      if (payload.noteId !== undefined && payload.noteId !== order.payment.noteId) fail(409, '付款资料已更新，请刷新订单后确认收款');
      if (order.payment.rejections?.length && (order.payment.status !== 'submitted' || !payload.noteId)) fail(409, '退回后的付款资料必须重新提交，并核对本次付款资料编号');
      if (this.db.prepare("SELECT id FROM orders WHERE json_extract(data,'$.payment.transactionId')=? AND id<>?").get(payload.transactionId, order.id)) fail(409, '该收款流水已用于其他订单');
      if (payload.amount !== order.payPrice) fail(409, '实收金额与应付金额不一致');
      if (order.payment.status === 'paid') {
        if (order.payment.transactionId !== payload.transactionId || order.payment.paidAt !== payload.collectedAt) fail(409, '订单已有不同的收款记录');
        return;
      }
      order.payment = { ...order.payment, status: 'paid', ...payload, paidAt: payload.collectedAt, payerId: order.ownerId, payerName: order.operatorName };
      order.review = { status: 'pending' };
      this.event(order, '确认收款', `收到管理端收款结果，金额 ${payload.amount} 分，等待审核。`);
    });
  }
  review(id, input) {
    const payload = { status: input.status, reviewerName: text(input.reviewerName, '审核人员', 80),
      reviewedAt: this.timestamp(input.reviewedAt, '审核时间'), reason: text(input.reason, '审核说明', 1000, true) };
    if (!['approved', 'rejected'].includes(payload.status)) fail(400, '审核状态仅支持 approved / rejected');
    if (payload.status === 'rejected' && !payload.reason) fail(400, '审核未通过需填写原因');
    return this.receive(id, 'review', input.eventId, payload, order => {
      if (order.payment.status !== 'paid') fail(409, '确认收款后才可审核');
      if (payload.reviewedAt < order.payment.paidAt) fail(409, '审核时间不能早于收款时间');
      if (order.review.status !== 'pending') fail(409, '订单已有审核结果');
      order.review = { ...payload, resultId: input.eventId };
      this.event(order, payload.status === 'approved' ? '管理端审核通过' : '管理端审核未通过', `${payload.reviewerName}：${payload.reason || '收款审核通过'}`);
      if (payload.status === 'approved') {
        order.external = { status: 'queued' };
        this.db.prepare("INSERT INTO fulfillment_jobs(id,order_id,status,created_at,updated_at) VALUES(?,?,'pending',?,?)")
          .run(`fulfillment-${order.id}`, order.id, this.now(), this.now());
        this.event(order, '等待创建履约订单', '审核通过后，由本后台向履约系统发起建单。');
      }
    });
  }
  link(id, input) {
    const payload = { timelyOrderId: text(input.timelyOrderId, '履约订单号', 120), description: text(input.description, '关联说明', 1000) };
    return this.receive(id, 'link', input.eventId, payload, order => {
      if (order.payment.status !== 'paid' || order.review.status !== 'approved') fail(409, '收款并审核通过后才可关联履约订单');
      if (order.external.timelyOrderId) { if (order.external.timelyOrderId !== payload.timelyOrderId) fail(409,'已关联其他履约订单'); return; }
      if (this.db.prepare('SELECT id FROM orders WHERE timely_order_id=? AND id<>?').get(payload.timelyOrderId,order.id)) fail(409,'履约订单已关联其他结算订单');
      order.external = {status:'created',timelyOrderId:payload.timelyOrderId,createdAt:this.now()};
      order.fulfillment = {status:'waiting',updatedAt:this.now()};
      this.event(order,'管理端核对履约订单后关联',payload.description);
      this.db.prepare("UPDATE fulfillment_jobs SET status='created', lease_until=0, updated_at=? WHERE order_id=?").run(this.now(),order.id);
    });
  }
  syncFulfillment(id, input) {
    this.store.transaction(() => {
      const order = this.get(id);
      if (order.review.status !== 'approved' || order.external.status !== 'created') throw new Error('未审核建单不能同步履约');
      const snapshot = fulfillmentSnapshot(input, order.external.timelyOrderId);
      const previous = order.fulfillment, now = this.now();
      if (snapshot.sourceUpdatedAt && previous.sourceUpdatedAt && snapshot.sourceUpdatedAt < previous.sourceUpdatedAt) {
        order.fulfillment = {...previous,syncAttemptedAt:now,syncMessage:'履约系统返回了较早的数据，保留当前记录'};
        this.store.write(order,now); return;
      }
      const phases = {0:'waiting',1:'accepted',2:'accepted',3:'accepted',4:'delivering',5:'delivered',7:'accepted'};
      const sequence = ['not_started','waiting','accepted','delivering','delivered'];
      const phase = phases[input.status];
      const status = phase && sequence.indexOf(phase) >= sequence.indexOf(previous.status) ? phase : previous.status;
      const next = {...previous,...snapshot,status};
      const fields = ['status','sourceCode','sourceStatus','hungup','errorOrder','errorMessage','messages','memos','deliveries'];
      const changed = fields.some(key=>JSON.stringify(previous[key])!==JSON.stringify(next[key]));
      const statusChanged = previous.sourceStatus !== next.sourceStatus;
      order.fulfillment = {...next,updatedAt:changed?now:previous.updatedAt,syncedAt:now,syncAttemptedAt:now};
      delete order.fulfillment.syncMessage;
      if (changed) this.event(order,statusChanged?`履约状态：${next.sourceStatus}`:'履约信息已更新',statusChanged?'从履约系统同步状态、备注和配送信息。':'已同步最新的履约备注和配送信息。');
      this.store.write(order,now);
    });
  }
  fulfillmentSyncFailed(id) {
    this.store.transaction(() => {
      const order = this.get(id);
      order.fulfillment = {...order.fulfillment,syncAttemptedAt:this.now(),syncMessage:'暂未同步到最新履约信息，保留上次记录，后台将继续重试'};
      this.store.write(order,this.now());
    });
  }
  fulfillment(id, input) {
    const payload = { timelyOrderId: text(input.timelyOrderId, '履约订单号', 120), status: input.status,
      occurredAt: this.timestamp(input.occurredAt, '履约更新时间') };
    const sequence = ['not_started', 'waiting', 'accepted', 'delivering', 'delivered'];
    if (!sequence.slice(1).includes(payload.status)) fail(400, '履约状态不正确');
    return this.receive(id, 'fulfillment', input.eventId, payload, order => {
      if (order.review.status !== 'approved' || order.external.status !== 'created') fail(409, '审核通过并创建履约订单后才可同步进度');
      if (order.external.timelyOrderId !== payload.timelyOrderId) fail(409, '履约订单号不匹配');
      if (payload.occurredAt < order.fulfillment.updatedAt || sequence.indexOf(payload.status) < sequence.indexOf(order.fulfillment.status)) fail(409, '履约进度不能回退');
      order.fulfillment = { ...order.fulfillment, status: payload.status, updatedAt: payload.occurredAt };
      delete order.fulfillment.sourceCode; delete order.fulfillment.sourceStatus;
      this.event(order, `履约状态：${payload.status}`, '收到履约系统状态回传。');
    });
  }
}
