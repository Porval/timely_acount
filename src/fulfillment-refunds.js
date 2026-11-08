import { AppError } from './service.js';

// A separate type keeps these markers out of the legacy platform refund queue.
const markerType = 2;
const markerId = order => `extras-refund-${order.refund.id}`;
const confirmationPrefix = order => `[${markerId(order)}:confirmed] `;
const unavailable = () => new AppError(502, '履约退款标识暂无法核对，请刷新后重试');

function markerState(marker, order) {
  if (!marker) return 'missing';
  if (marker.type !== markerType || typeof marker.id !== 'string' || !marker.id.trim()) return 'blocked';
  if (marker.status === 0) return 'open';
  if (marker.status === 1 && typeof marker.descs === 'string') {
    try {
      const notes = JSON.parse(marker.descs);
      if (Array.isArray(notes) && notes.some(note => typeof note?.desc === 'string' && note.desc.startsWith(confirmationPrefix(order)))) return 'confirmed';
    } catch {}
  }
  return 'blocked';
}

export function createFulfillmentRefunds({ get, post }) {
  async function read(order) {
    let snapshot;
    try { snapshot = await get(`admin/order/${encodeURIComponent(order.external.timelyOrderId)}`); }
    catch { throw unavailable(); }
    if (!snapshot || String(snapshot.id) !== order.external.timelyOrderId || !Array.isArray(snapshot.refundReqs)) throw unavailable();
    const matches = snapshot.refundReqs.filter(row => row?.reqId === markerId(order));
    const marker = matches[0];
    const state = matches.length > 1 ? 'blocked' : markerState(marker, order);
    const operatorId = typeof snapshot.operatorId === 'string' ? snapshot.operatorId : '';
    return { snapshot, marker, state, operatorId };
  }

  async function writeAndInspect(order, current, path, input) {
    let saved;
    try { saved = await post(path, input); } catch {}
    // A unique reqId lets a timed-out write be recovered by reading the linked order.
    if (saved?.reqId === markerId(order) && String(saved.timelyOrder?.id) === order.external.timelyOrderId) {
      const state = markerState(saved, order);
      return { state, operatorId: current.operatorId };
    }
    const { state, operatorId } = await read(order);
    if (state === current.state) throw unavailable();
    return { state, operatorId };
  }

  return {
    async inspect(order) {
      const { state, operatorId } = await read(order);
      return { state, operatorId };
    },
    async mark(order) {
      const current = await read(order);
      const { state, operatorId, snapshot } = current;
      if (state !== 'missing') return { state, operatorId };
      // The old create route resolves this globally unique reference, not the primary key.
      if (typeof snapshot.referenceId !== 'string' || !snapshot.referenceId.trim()) throw unavailable();
      return writeAndInspect(order, current, 'admin/refundReqs/', {
        orderId: snapshot.referenceId, reqId: markerId(order), type: markerType, messages: `服务商退款申请：${order.refund.reason}`,
      });
    },
    async confirm(order, actor) {
      const current = await read(order);
      const { state, operatorId, marker } = current;
      if (!operatorId || operatorId !== actor.operatorId) throw new AppError(403, '请由这笔履约单的接单人员确认退款标识');
      if (state !== 'open') return { state, operatorId };
      // This legacy route only records agreement in RefundReq. The similarly named
      // agreeRefundReq route also triggers a marketplace refund and must not be used.
      return writeAndInspect(order, current, `admin/action/markRefundReqError/${encodeURIComponent(marker.id)}`, {
        desc: `${confirmationPrefix(order)}${actor.operatorName} 已确认退款标识`,
      });
    },
  };
}
