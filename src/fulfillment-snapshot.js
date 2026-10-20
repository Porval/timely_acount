export const sourceStatuses = { 0:'待接单', 1:'已接单', 2:'履约方已付款', 3:'已呼叫跑腿', 4:'配送中', 5:'已送达', 6:'已退款', 7:'履约方已申请付款', 8:'履约异常' };
const deliveryStatuses = { 0:'待发起配送', 1:'待接单', 2:'待取货', 3:'配送中', 4:'已送达', 5:'已取消', 6:'配送异常', 7:'自配送', 8:'配送异常' };
const clean = (value, max = 2000) => typeof value === 'string' ? value.trim().slice(0, max) : '';
const idText = value => ['string','number'].includes(typeof value) ? String(value).slice(0,120) : '';
const time = value => { const number = typeof value === 'number' ? value : typeof value === 'string' ? Date.parse(value) : NaN; return Number.isFinite(number) && number > 0 ? number : undefined; };
const has = (value,key) => Object.prototype.hasOwnProperty.call(value,key);
export function fulfillmentSnapshot(input, linkedId) {
  if (!input || String(input.id) !== linkedId || !Number.isInteger(input.status) || !has(sourceStatuses,input.status)) throw new Error('履约订单响应不匹配或状态异常');
  const result = { sourceCode:input.status, sourceStatus:input.hungup ? '已挂起' : input.errorOrder ? '履约异常' : sourceStatuses[input.status], hungup:input.hungup === true, errorOrder:input.errorOrder === true, errorMessage:clean(input.errorDesc), ...(time(input.updatedAt)?{sourceUpdatedAt:time(input.updatedAt)}:{}) };
  if (has(input,'messages')) result.messages = clean(input.messages,4000);
  if (has(input,'memos')) {
    if (input.memos !== null && !Array.isArray(input.memos)) throw new Error('履约备注响应异常');
    result.memos = (input.memos || []).filter(memo => memo && typeof memo.content === 'string').slice(0,100).map(memo => ({id:idText(memo.id),content:clean(memo.content,4000),createdAt:time(memo.createdAt)})).sort((a,b)=>(b.createdAt||0)-(a.createdAt||0)||a.id.localeCompare(b.id));
  }
  if (has(input,'deliveryLogistics') || has(input,'logiticsOrder')) {
    const raw = has(input,'deliveryLogistics') ? input.deliveryLogistics : input.logiticsOrder;
    const deliveries = raw === null ? [] : Array.isArray(raw) ? raw : raw && typeof raw === 'object' ? [raw] : null;
    if (!deliveries) throw new Error('配送信息响应异常');
    result.deliveries = deliveries.slice(0,20).map(row => {
      if (!row || typeof row !== 'object' || (row.timelyOrder?.id !== undefined && String(row.timelyOrder.id) !== linkedId) || (row.timelyOrderId !== undefined && String(row.timelyOrderId) !== linkedId)) throw new Error('配送订单关联不匹配');
      const logs = Array.isArray(row.callLogs) ? row.callLogs.filter(log => log && (row.channel === undefined || log.channel === row.channel)).slice().sort((a,b)=>(time(b.createdAt)||0)-(time(a.createdAt)||0)) : [];
      return { id:idText(row.id), channel:clean(row.channelName) || ({0:'美团配送',1:'闪送'})[row.channel] || '配送平台', orderNo:idText(row.logiticsOrderId || row.logisticsOrderId || row.isOrderNo || logs[0]?.deliveryOrderId), statusCode:Number.isInteger(row.status)?row.status:undefined, status:deliveryStatuses[row.status] || '待同步配送状态', riderName:clean(row.deliverier,100), riderPhone:clean(row.mobile,100), tips:clean(row.deliveryTips,4000), errorMessage:clean(row.errorMsg), fromName:clean(row.fromName,100), fromPhone:clean(row.fromPhone,100), fromAddress:clean(row.fromDetailAddress), toName:clean(row.toName,100), toPhone:clean(row.toPhone,100), toAddress:clean(row.toDetailAddress), updatedAt:time(row.updatedAt) };
    }).sort((a,b)=>(b.updatedAt||0)-(a.updatedAt||0)||a.id.localeCompare(b.id));
  }
  return result;
}
