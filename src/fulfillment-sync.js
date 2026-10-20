export class FulfillmentSynchronizer {
  constructor(orders, client, {intervalMs=15000,batchSize=10}={}) { this.orders=orders;this.client=client;this.intervalMs=intervalMs;this.batchSize=batchSize;this.pending=new Map();this.closed=false;this.busy=false; }
  start() {
    if (!this.client?.query) return;
    const run=()=>this.runOnce().catch(()=>console.error('履约信息同步暂未完成，后台将继续重试。'));
    this.timer=setInterval(run,this.intervalMs);this.timer.unref();run();
  }
  refresh(id,{force=false}={}) {
    if (this.pending.has(id)) return this.pending.get(id);
    const order=this.orders.get(id);
    if (this.closed || !this.client?.query || order.review.status!=='approved' || order.external.status!=='created' || !order.external.timelyOrderId || (!force && order.fulfillment.syncAttemptedAt && this.orders.now()-order.fulfillment.syncAttemptedAt<this.intervalMs)) return Promise.resolve(order);
    const task=Promise.resolve().then(async()=>{
      try { this.orders.syncFulfillment(id,await this.client.query(order.external.timelyOrderId)); }
      catch { this.orders.fulfillmentSyncFailed(id); }
      finally { this.pending.delete(id); }
      return this.orders.get(id);
    });
    this.pending.set(id,task);return task;
  }
  async runOnce() {
    if (this.closed || this.busy || !this.client?.query) return;
    this.busy=true;
    try {
      const rows=this.orders.db.prepare("SELECT id FROM orders WHERE timely_order_id IS NOT NULL AND json_extract(data,'$.review.status')='approved' AND json_extract(data,'$.external.status')='created' AND coalesce(json_extract(data,'$.fulfillment.syncAttemptedAt'),0)<=? ORDER BY coalesce(json_extract(data,'$.fulfillment.syncAttemptedAt'),0),created_at,id LIMIT ?").all(this.orders.now()-this.intervalMs,this.batchSize);
      let index=0;
      const worker=async()=>{while(!this.closed&&index<rows.length){const row=rows[index++];await this.refresh(row.id);}};
      await Promise.all([worker(),worker()]);
    } finally {this.busy=false;}
  }
  async close() {this.closed=true;clearInterval(this.timer);while(this.busy||this.pending.size)await new Promise(resolve=>setTimeout(resolve,10));}
}
