import { createHash, randomUUID } from 'node:crypto';
import { AppError } from './service.js';

function requiredText(value, label, limit) {
  const normalized = typeof value === 'string' ? value.trim() : '';
  if (!normalized || normalized.length > limit) throw new AppError(400, label + '不正确');
  return normalized;
}

const waitingForEvidence = new Set(['mark_pending', 'awaiting_fulfillment']);
const pendingMessage = '履约标识结果待核对，请刷新订单后查看。';

export class RefundService {
  constructor(orders, adapter, enabled) {
    this.orders = orders;
    this.adapter = adapter;
    this.enabled = enabled === true && ['inspect', 'mark', 'confirm'].every(action => typeof adapter?.[action] === 'function');
    this.marking = new Map();
  }

  requireEnabled() {
    if (!this.enabled) throw new AppError(503, '退款申请功能尚未启用');
  }

  canRequest(order) {
    return this.enabled && !order.refund && order.payment.status === 'paid' &&
      order.external.status === 'created' && Boolean(order.external.timelyOrderId);
  }

  request(orderId, account, input, idempotencyKey) {
    this.requireEnabled();
    this.orders.get(orderId, account.id);
    const key = requiredText(idempotencyKey, 'Idempotency-Key', 120);
    const reason = requiredText(input.reason, '退款原因', 200);
    const eventId = 'refund-request:' + createHash('sha256').update(JSON.stringify([account.id, key])).digest('hex');
    const { order } = this.orders.receive(orderId, 'refund-request', eventId, { reason }, current => {
      if (!this.canRequest(current)) throw new AppError(409, '当前订单无法申请退款');
      current.refund = { id: randomUUID(), status: 'requested', reason, requestedAt: this.orders.now() };
      this.orders.event(current, '申请退款', account.personName + '提交了退款申请。');
    });
    return { order };
  }

  currentRefund(order, refundId) {
    if (!order.refund || order.refund.id !== refundId) throw new AppError(404, '退款申请不存在');
    return order.refund;
  }

  async mark(orderId, input) {
    this.requireEnabled();
    const refundId = requiredText(input.refundId, '退款申请编号', 120);
    const operatorName = requiredText(input.operatorName, '操作人', 80);
    const result = this.orders.receive(orderId, 'refund-mark', input.eventId, { refundId, operatorName }, order => {
      const refund = this.currentRefund(order, refundId);
      if (refund.status !== 'requested') return false;
      refund.status = 'mark_pending';
      refund.message = pendingMessage;
      this.orders.event(order, '发起履约退款标识', operatorName + '发起了履约退款标识。');
    });
    if (result.order.refund.status !== 'mark_pending') return result;

    let task = this.marking.get(refundId);
    if (!task) {
      task = this.adapter.mark(result.order).then(evidence => this.recordEvidence(orderId, refundId, evidence))
        .finally(() => this.marking.delete(refundId));
      this.marking.set(refundId, task);
    }
    return { ...result, order: await task };
  }

  recordEvidence(orderId, refundId, evidence, operatorName) {
    return this.orders.store.transaction(() => {
      const order = this.orders.get(orderId);
      const refund = this.currentRefund(order, refundId);
      if (!waitingForEvidence.has(refund.status)) return order;
      const previousStatus = refund.status;
      const previousMessage = refund.message;
      const now = this.orders.now();
      if (evidence.state === 'confirmed') {
        refund.markedAt ??= now;
        refund.confirmedAt = now;
        refund.status = 'ready_to_refund';
        delete refund.message;
        this.orders.event(order, '履约已确认退款标识', operatorName ? operatorName + '确认了履约退款标识。' : '已从履约系统核对退款标识。');
      } else if (evidence.state === 'open') {
        refund.markedAt ??= now;
        refund.status = 'awaiting_fulfillment';
        delete refund.message;
        if (previousStatus !== refund.status) this.orders.event(order, '履约退款标识已创建', '等待履约人员确认。');
      } else {
        refund.message = evidence.state === 'blocked' ? '履约退款标识暂无法继续，请核对履约订单。' : pendingMessage;
      }
      if (refund.status !== previousStatus || refund.message !== previousMessage) this.orders.store.write(order, now);
      return order;
    });
  }

  async refresh(order) {
    if (!this.enabled || !waitingForEvidence.has(order.refund?.status)) return order;
    let evidence;
    try {
      evidence = await this.adapter.inspect(order);
    } catch (error) {
      if (error instanceof AppError && error.status === 502) return this.orders.get(order.id);
      throw error;
    }
    return this.recordEvidence(order.id, order.refund.id, evidence);
  }

  async confirm(refundId, input) {
    this.requireEnabled();
    const operatorId = requiredText(input.operatorId, '履约人员编号', 120);
    const operatorName = requiredText(input.operatorName, '履约人员', 80);
    const row = this.orders.db.prepare("SELECT id FROM orders WHERE json_extract(data,'$.refund.id')=?").get(refundId);
    if (!row) throw new AppError(404, '退款申请不存在');
    const order = this.orders.get(row.id);
    const refund = this.currentRefund(order, refundId);
    if (refund.status === 'requested') throw new AppError(409, '管理端尚未发起履约退款标识');

    const evidence = refund.status === 'initiated'
      ? await this.adapter.inspect(order)
      : await this.adapter.confirm(order, { operatorId, operatorName });
    if (evidence.operatorId !== operatorId) throw new AppError(403, '只有该履约订单的接单人员可以确认');
    if (refund.status === 'initiated') return { status: 'initiated' };
    if (evidence.state !== 'confirmed') throw new AppError(409, '履约退款标识尚未确认');

    const saved = this.recordEvidence(order.id, refundId, evidence, operatorName);
    return { status: saved.refund.status };
  }

  async initiate(orderId, input) {
    this.requireEnabled();
    const refundId = requiredText(input.refundId, '退款申请编号', 120);
    const eventId = requiredText(input.eventId, 'eventId', 120);
    const operatorName = requiredText(input.operatorName, '操作人', 80);
    const order = this.orders.get(orderId);
    const refund = this.currentRefund(order, refundId);
    if (refund.status !== 'initiated') {
      if (refund.status !== 'ready_to_refund') throw new AppError(409, '请等待履约人员确认退款标识');
      const evidence = await this.adapter.inspect(order);
      if (evidence.state !== 'confirmed') throw new AppError(409, '履约退款标识当前未确认，请重新核对');
    }

    return this.orders.receive(orderId, 'refund-initiate', eventId, { refundId, operatorName }, current => {
      const currentRefund = this.currentRefund(current, refundId);
      if (currentRefund.status === 'initiated') return false;
      if (currentRefund.status !== 'ready_to_refund') throw new AppError(409, '请等待履约人员确认退款标识');
      currentRefund.status = 'initiated';
      currentRefund.initiatedAt = this.orders.now();
      this.orders.event(current, '已发起退款', operatorName + '确认发起退款，款项按线下流程处理。');
    });
  }
}
