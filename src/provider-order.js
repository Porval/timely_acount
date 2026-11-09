const phases = ['waiting', 'accepted', 'delivering', 'delivered'];
const labels = ['待接单', '已接单', '配送中', '已完成'];
const timelinePhases = new Map([
  ...phases.map((phase, index) => [phase, index]),
  ...labels.map((label, index) => [label, index]),
  ['履约方已付款', 1], ['已呼叫跑腿', 1], ['履约方已申请付款', 1], ['已送达', 3],
]);
const fulfillmentPrefix = '履约状态：';
const createdEvents = new Set(['履约订单创建成功', '管理端核对履约订单后关联']);

function providerDelivery({ id, channel, orderNo, riderName, riderPhone, status }) {
  const selfDelivery = status === '自配送' && (!channel || channel === '配送平台');
  return { id, channel: selfDelivery ? '自配送' : channel, orderNo, riderName, riderPhone };
}

export function providerOrder(order) {
  const { fulfillment, external } = order;
  const phase = external.status === 'created' ? Math.max(0, phases.indexOf(fulfillment.status)) : -1;
  const events = [];
  let latestPhase = -1;
  let updatedAt;
  for (const event of order.events) {
    let eventPhase;
    if (event.title.startsWith(fulfillmentPrefix)) {
      eventPhase = timelinePhases.get(event.title.slice(fulfillmentPrefix.length));
    } else if (createdEvents.has(event.title)) {
      eventPhase = 0;
    } else {
      if (event.title !== '履约信息已更新') events.push(event);
      continue;
    }
    if (eventPhase === undefined || eventPhase <= latestPhase || eventPhase > phase) continue;
    events.push({ id: event.id, time: event.time, title: fulfillmentPrefix + labels[eventPhase], description: '' });
    latestPhase = eventPhase;
    updatedAt = event.time;
  }
  if (phase > latestPhase) {
    // Some legacy snapshots have a canonical phase without a corresponding public milestone.
    const time = phase === 0 ? external.createdAt ?? fulfillment.updatedAt : fulfillment.updatedAt;
    if (time !== undefined) {
      events.push({ id: order.id + '-fulfillment-' + phases[phase], time, title: fulfillmentPrefix + labels[phase], description: '' });
      events.sort((first, second) => first.time - second.time);
      updatedAt = time;
    }
  }

  const status = phases[phase] ?? 'not_started';
  return {
    ...order,
    external: { status: external.status, timelyOrderId: external.timelyOrderId, createdAt: external.createdAt },
    fulfillment: {
      status,
      ...(updatedAt === undefined ? {} : { updatedAt }),
      ...(status === 'delivering' ? { deliveries: (fulfillment.deliveries ?? []).map(providerDelivery) } : {}),
    },
    events,
  };
}
