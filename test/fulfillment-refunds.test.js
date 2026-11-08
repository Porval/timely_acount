import assert from 'node:assert/strict';
import test from 'node:test';
import { createFulfillmentClient, signParams } from '../src/fulfillment.js';

const config = { timelyHost: 'https://fulfillment.test/base/', timelyKey: 'key', timelySecret: 'secret', timelyService: 'service', timelyCreator: 'creator' };
const now = () => 1700000000000;
const order = { referenceId: 'editable-ref', external: { timelyOrderId: 'actual-timely-id' }, refund: { id: 'refund-id', reason: '申请原因' } };
const actor = { operatorId: 'assigned-person', operatorName: '接单人' };
const markerId = 'extras-refund-refund-id';

function fixture() {
  const snapshot = { id: 'actual-timely-id', referenceId: 'actual-reference', operatorId: actor.operatorId, refundReqs: [] };
  const writes = [];
  let loseReply = false;
  const client = createFulfillmentClient(config, async (url, options) => {
    const target = new URL(url);
    if (options.method !== 'POST') {
      assert.equal(target.pathname, '/base/admin/order/actual-timely-id');
      assert.deepEqual(Object.fromEntries(target.searchParams), signParams({}, config.timelyKey, config.timelySecret, now));
      return { ok: true, json: async () => structuredClone(snapshot) };
    }
    const input = JSON.parse(options.body);
    writes.push({ path: target.pathname, input });
    assert.equal(options.redirect, 'error');
    let marker;
    if (target.pathname === '/base/admin/refundReqs/') {
      marker = { id: 'legacy-marker', reqId: input.reqId, status: 0, type: input.type };
      snapshot.refundReqs.push(marker);
    } else {
      assert.equal(target.pathname, '/base/admin/action/markRefundReqError/legacy-marker');
      marker = snapshot.refundReqs[0];
      marker.status = 1;
      marker.descs = JSON.stringify([{ desc: input.desc }]);
    }
    if (loseReply) throw Error('模拟履约已保存、网络响应中断');
    return { ok: true, json: async () => ({ ...marker, timelyOrder: { id: snapshot.id } }) };
  }, now);
  return { snapshot, writes, adapter: client.refunds, interruptReply: () => { loseReply = true; } };
}

test('退款标识按履约单的唯一外部号写入，只有接单人可确认，网络中断后按同一标识读回', async () => {
  const f = fixture();
  f.interruptReply();
  assert.equal((await f.adapter.mark(order)).state, 'open');
  assert.equal((await f.adapter.mark(order)).state, 'open');
  assert.deepEqual(f.writes[0].input, signParams({
    orderId: 'actual-reference', reqId: markerId, type: 2, messages: '服务商退款申请：申请原因',
  }, config.timelyKey, config.timelySecret, now));
  await assert.rejects(f.adapter.confirm(order, { ...actor, operatorId: 'other-person' }), { status: 403 });
  assert.equal(f.writes.length, 1);
  assert.equal((await f.adapter.confirm(order, actor)).state, 'confirmed');
  assert.equal((await f.adapter.inspect(order)).state, 'confirmed');
  assert.equal((await f.adapter.confirm(order, actor)).state, 'confirmed');
  assert.equal(f.writes.length, 2);
  assert.match(f.writes[1].input.desc, /^\[extras-refund-refund-id:confirmed\] /);
});

test('履约已退款状态、别的申请和没有专用确认记录的旧状态都无法放行', async () => {
  const f = fixture();
  f.snapshot.status = 6;
  f.snapshot.refundReqs.push({ id: 'different-marker', reqId: 'another-refund', type: 2, status: 1 });
  assert.equal((await f.adapter.inspect(order)).state, 'missing');
  f.snapshot.refundReqs.push({ id: 'legacy-marker', reqId: markerId, type: 2, status: 1, descs: '[{"desc":"旧确认"}]' });
  assert.equal((await f.adapter.inspect(order)).state, 'blocked');
  assert.equal((await f.adapter.confirm(order, actor)).state, 'blocked');
  assert.equal(f.writes.length, 0);
  f.snapshot.id = 'wrong-order';
  await assert.rejects(f.adapter.mark(order), { status: 502 });
  assert.equal(f.writes.length, 0);
});
