import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../src/server.js';
import { SQLiteStore } from '../src/store.js';
import { AccountService } from '../src/service.js';
import { OrderService } from '../src/order-service.js';
import { FulfillmentDispatcher, createFulfillmentClient, signParams } from '../src/fulfillment.js';

const screenshot = {contentType:'image/png',data:'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jZAAAAABJRU5ErkJggg=='};
const token = 'test-management-token-for-server-only-12345';
const input = () => ({cityId:'city',cityName:'上海',brandId:'brand',brandName:'测试品牌',plateId:'plate',platformName:'美团',items:[{itemName:'测试商品',spec:'',salesPrice:1234,quantity:2}],contacts:'测试收件人和地址',messages:'',referenceId:'ORDER-001',payPrice:2468,arrivedTime:30});
async function fixture(t, options = {}, fulfillmentClient) {
  const dir = mkdtempSync(join(tmpdir(), 'order-api-test-')); const store = new SQLiteStore(join(dir,'accounts.sqlite'));
  const sms = []; const accounts = new AccountService({store,sendSms:async data=>sms.push(data)});
  const owner=accounts.createAccount({providerName:'测试',personName:'建单人员',mobile:'13800138000'});
  const other=accounts.createAccount({providerName:'另一服务商',personName:'其他人员',mobile:'13900139000'});
  const orders = new OrderService(store); const server=createApp({store,sendSms:async data=>sms.push(data),config:{smsMode:'console',production:false,managementToken:token,...options},fulfillmentClient});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(()=>new Promise(resolve=>{server.close(()=>{rmSync(dir,{recursive:true,force:true});resolve()});server.closeAllConnections()}));
  const base=`http://127.0.0.1:${server.address().port}`;
  const call=async(path,{method='GET',body,cookie,key=token,management=false,headers={}}={})=>{
    const response=await fetch(base+path,{method,headers:{...(cookie?{Cookie:cookie}:{}),...(body?{'Content-Type':'application/json'}:{}),...(management?{Authorization:`Bearer ${key}`} :{}),...headers},body:body?JSON.stringify(body):undefined});
    return {status:response.status,data:await response.json(),cookie:response.headers.get('set-cookie')};
  };
  const login=async(account)=>{const {code}=await accounts.requestCode(account.mobile);return (await call('/api/auth/login',{method:'POST',body:{mobile:account.mobile,code}})).cookie;};
  const cookie=await login(owner); const create=async(payload=input(),key='create-001')=>call('/api/orders',{method:'POST',cookie,body:payload,headers:{'Idempotency-Key':key}});
  return {store,orders,owner,other,call,login,cookie,create,base};
}

test('订单实际入库、登录身份防伪、重复创建幂等和账号隔离',async t=>{
  const f=await fixture(t);const created=await f.create({...input(),ownerId:f.other.id,operatorName:'伪造'});assert.equal(created.status,201);
  const order=created.data.order;assert.equal(order.ownerId,f.owner.id);assert.equal(order.operatorName,'建单人员');
  assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM orders').get().n,1);
  assert.equal((await f.create()).status,200);assert.equal((await f.create({...input(),payPrice:100})).status,409);
  const otherCookie=await f.login(f.other);assert.equal((await f.call(`/api/orders/${order.id}`,{cookie:otherCookie})).status,404);
  assert.equal((await f.call('/api/orders',{cookie:otherCookie})).data.total,0);
  assert.equal((await f.call('/api/orders')).status,401);
  assert.equal((await f.create({...input(),referenceId:'bad',payPrice:24.68},'other-key')).status,400);
});
test('手动付款提交不代表收款，也不能自行审核；金额和重复流水严格校验',async t=>{
  const f=await fixture(t);const order=(await f.create()).data.order;
  const path=`/api/order-management/orders/${order.id}`;
  const submitted=await f.call(`/api/orders/${order.id}/manual-payment`,{method:'POST',cookie:f.cookie,body:{reference:'BANK-001',description:'手动付款',screenshot}});
  assert.equal(submitted.data.order.payment.status,'submitted');assert.equal(submitted.data.order.external.status,'not_created');
  assert.equal((await f.call(`${path}/review`,{method:'POST',cookie:f.cookie,body:{}})).status,401);
  const review={eventId:'review-1',status:'approved',reviewerName:'管理端',reviewedAt:Date.now()};
  assert.equal((await f.call(`${path}/review`,{method:'POST',management:true,body:review})).status,409);
  const receipt={eventId:'receipt-1',transactionId:'BANK-001',amount:2468,collectedAt:Date.now()};
  assert.equal((await f.call(`${path}/receipt`,{method:'POST',management:true,body:{...receipt,amount:1}})).status,409);
  assert.equal((await f.call(`${path}/receipt`,{method:'POST',management:true,body:receipt})).status,200);
  assert.equal((await f.call(`${path}/receipt`,{method:'POST',management:true,body:receipt})).data.replayed,true);
  assert.equal((await f.call(`${path}/receipt`,{method:'POST',management:true,body:{...receipt,amount:2}})).status,409);
  assert.equal((await f.call(`${path}/receipt`,{method:'POST',management:true,key:'wrong',body:receipt})).status,401);
  assert.equal(f.orders.get(order.id).review.status,'pending');assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM fulfillment_jobs').get().n,0);
});
test('审核通过持久化建单任务，返回关联ID后可同步履约；防重复审核与回退',async t=>{
  const f=await fixture(t);const order=(await f.create()).data.order;const path=`/api/order-management/orders/${order.id}`;
  const receivedAt=Date.now();await f.call(`${path}/receipt`,{method:'POST',management:true,body:{eventId:'receipt',transactionId:'BANK',amount:2468,collectedAt:receivedAt}});
  const review={eventId:'review',status:'approved',reviewerName:'审核人',reviewedAt:receivedAt,reason:'核实到账'};
  const approved=await f.call(`${path}/review`,{method:'POST',management:true,body:review});assert.equal(approved.status,200);assert.equal(approved.data.order.external.status,'queued');
  assert.equal((await f.call(`${path}/review`,{method:'POST',management:true,body:review})).data.replayed,true);
  assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM fulfillment_jobs').get().n,1);
  let creates=0;const dispatcher=new FulfillmentDispatcher(f.orders,async(o,key)=>{creates++;assert.equal(o.review.status,'approved');assert.equal(key,`fulfillment-${order.id}`);return 'timely-123'});
  await dispatcher.runOnce();await dispatcher.runOnce();assert.equal(creates,1);assert.equal(f.orders.get(order.id).external.timelyOrderId,'timely-123');
  const fulfilled={eventId:'delivered',timelyOrderId:'timely-123',status:'delivered',occurredAt:Date.now()};
  assert.equal((await f.call(`${path}/fulfillment`,{method:'POST',management:true,body:fulfilled})).status,200);
  assert.equal((await f.call(`${path}/fulfillment`,{method:'POST',management:true,body:{...fulfilled,eventId:'backwards',status:'accepted'}})).status,409);
  assert.equal((await f.call(`${path}/fulfillment`,{method:'POST',management:true,body:{...fulfilled,eventId:'foreign',timelyOrderId:'wrong'}})).status,409);
  assert.equal(f.orders.get(order.id).fulfillment.status,'delivered');
});
test('审核不通过不会建单；任务失败保留，重启读取订单和任务数据',async t=>{
  const f=await fixture(t);const order=(await f.create()).data.order;
  f.orders.receipt(order.id,{eventId:'receipt',transactionId:'BANK',amount:2468,collectedAt:Date.now()});
  f.orders.review(order.id,{eventId:'review',status:'rejected',reviewerName:'管理端',reason:'信息需要核实',reviewedAt:Date.now()});
  assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM fulfillment_jobs').get().n,0);
  const second=(await f.create({...input(),referenceId:'ORDER-002'},'create-002')).data.order;
  f.orders.receipt(second.id,{eventId:'receipt-2',transactionId:'BANK-2',amount:2468,collectedAt:Date.now()});
  f.orders.review(second.id,{eventId:'review-2',status:'approved',reviewerName:'管理端',reviewedAt:Date.now()});
  await new FulfillmentDispatcher(f.orders,async()=>{throw new Error('timeout')},{allowRetry:true}).runOnce();
  const reopened=new SQLiteStore(f.store.path);t.after(()=>reopened.close());const recovered=new OrderService(reopened);
  assert.equal(recovered.get(second.id).external.status,'retry');assert.equal(reopened.db.prepare('SELECT status FROM fulfillment_jobs WHERE order_id=?').get(second.id).status,'retry');
});
test('履约签名和数据字段与参考工程一致，接口不返回有效ID时不能标为已建单',async()=>{
  const config={timelyHost:'http://127.0.0.1:9/base/',timelyKey:'key',timelySecret:'secret',timelyService:'service',timelyCreator:'creator'};
  let request;const client=createFulfillmentClient(config,async(url,options)=>{request={url,options};return {ok:true,json:async()=>({error:false,data:{id:'new-timely'}})}},()=>1700000000000);
  const order={...input(),providerName:'测试服务商'};assert.equal(await client(order,'stable-key'),'new-timely');
  assert.equal(request.url,'http://127.0.0.1:9/base/admin/timelyOrders/');assert.equal(request.options.headers['Idempotency-Key'],'stable-key');
  const payload=JSON.parse(request.options.body);assert.equal(payload.payPrice,24.68);assert.equal(payload.plateFormId,order.plateId);assert.equal(payload.plateId,undefined);assert.deepEqual(JSON.parse(payload.items),order.items);
  const {sign,...unsigned}=payload;assert.equal(sign,signParams(Object.fromEntries(Object.entries(unsigned).filter(([k])=>!['appKey','date'].includes(k))),'key','secret',()=>1700000000000).sign);
  await assert.rejects(createFulfillmentClient(config,async()=>({ok:true,json:async()=>({error:false,data:{}})}))(order,'key'),/有效订单/);
});

test('发起方进度筛选及建单结果未确认时不会自动重复请求',async t=>{
  const f=await fixture(t);const order=(await f.create()).data.order;
  const submitted=await f.call(`/api/orders/${order.id}/manual-payment`,{method:'POST',cookie:f.cookie,body:{reference:'TEST-REF',description:'人工付款',screenshot}});
  assert.equal(submitted.status,200);
  assert.equal((await f.call('/api/orders?stage='+encodeURIComponent('待收款确认')+'&item='+encodeURIComponent('测试商品'),{cookie:f.cookie})).data.total,1);
  assert.equal((await f.call('/api/orders?stage='+encodeURIComponent('待付款'),{cookie:f.cookie})).data.total,0);
  f.orders.receipt(order.id,{eventId:'receipt-final',transactionId:'TX-FINAL',amount:2468,collectedAt:Date.now()});
  f.orders.review(order.id,{eventId:'review-final',status:'approved',reviewerName:'审核人员',reviewedAt:Date.now()});
  let attempts=0;const worker=new FulfillmentDispatcher(f.orders,async()=>{attempts++;throw new Error('uncertain result')});
  await worker.runOnce();await worker.runOnce();assert.equal(attempts,1);assert.equal(f.orders.get(order.id).external.status,'attention');
  f.orders.link(order.id,{eventId:'manual-link',timelyOrderId:'confirmed-order',description:'已核对外部订单存在，不重复创建'});
  assert.equal(f.orders.get(order.id).external.timelyOrderId,'confirmed-order');
  assert.equal(f.store.db.prepare('SELECT status FROM fulfillment_jobs WHERE order_id=?').get(order.id).status,'created');
});

test('重启前遗留未确认的建单请求保持人工核对，不能回退已确认关联',async t=>{
  const f=await fixture(t);const order=(await f.create()).data.order;
  f.orders.receipt(order.id,{eventId:'receipt-stale',transactionId:'TX-STALE',amount:2468,collectedAt:Date.now()});
  f.orders.review(order.id,{eventId:'review-stale',status:'approved',reviewerName:'审核人员',reviewedAt:Date.now()});
  f.store.db.prepare("UPDATE fulfillment_jobs SET status='sending',lease_until=1 WHERE order_id=?").run(order.id);
  let attempts=0;await new FulfillmentDispatcher(f.orders,async()=>{attempts++;return 'unwanted'}).runOnce();
  assert.equal(attempts,0);assert.equal(f.orders.get(order.id).external.status,'attention');
  f.orders.link(order.id,{eventId:'link-stale',timelyOrderId:'verified',description:'外部核对成功'});
  assert.throws(()=>f.orders.link(order.id,{eventId:'link-other',timelyOrderId:'different',description:'不能覆盖'}),/其他履约/);
  f.orders.syncFulfillment(order.id,{id:'verified',status:3});assert.equal(f.orders.get(order.id).fulfillment.sourceStatus,'已呼叫跑腿');
  f.orders.syncFulfillment(order.id,{id:'verified',status:5});assert.equal(f.orders.get(order.id).fulfillment.status,'delivered');
});


test('真实目录沿用旧工程全量参数，并限制为配置服务商对应的平台', async () => {
  const config = {timelyHost:'http://127.0.0.1:9/base/',timelyKey:'key',timelySecret:'secret',timelyService:'service',timelyCreator:'creator',timelyPlatform:'configured-platform'};
  const paths = [];
  const client = createFulfillmentClient(config, async (url) => {
    const parsed = new URL(url); paths.push(parsed);
    const data = parsed.pathname.endsWith('/plateForms/') ? [{id:'other-platform',name:'其他平台'},{id:'configured-platform',name:'服务商所属平台'}] : [{id:'catalog-id',name:'目录条目'}];
    return {ok:true,json:async()=>data};
  });
  const options = await client.options();
  assert.equal(options.demo,false);assert.deepEqual(options.platforms,[{id:'configured-platform',name:'服务商所属平台'}]);
  assert.equal(paths.length,3);
  for (const url of paths) {assert.equal(url.searchParams.get('pageSize'),'0');assert.equal(url.searchParams.has('page'),false);}
  assert.equal(paths.find(url=>url.pathname.endsWith('/brands/')).searchParams.get('locked'),'true');
  await assert.rejects(client({...input(),providerName:'服务商'},'stable-key'),/平台.*不匹配/);
  assert.equal(paths.length,3,'平台不匹配时不得发送真实建单请求');
});


test('付款截图必填、真实类型校验、二进制持久化与账号访问隔离',async t=>{
  const f=await fixture(t),order=(await f.create()).data.order;
  const path=`/api/orders/${order.id}/manual-payment`,payload={reference:'SCREENSHOT-1',description:'截图付款'};
  assert.equal((await f.call(path,{method:'POST',cookie:f.cookie,body:payload})).status,400);
  assert.equal((await f.call(path,{method:'POST',cookie:f.cookie,body:{...payload,screenshot:{contentType:'image/png',data:Buffer.from('<svg/>').toString('base64')}}})).status,400);
  assert.equal(f.orders.get(order.id).payment.status,'unpaid');
  const submitted=await f.call(path,{method:'POST',cookie:f.cookie,body:{...payload,screenshot}});
  assert.equal(submitted.status,200);assert.equal(submitted.data.order.payment.status,'submitted');assert.ok(submitted.data.order.payment.screenshot.id);
  assert.equal((await f.call(path,{method:'POST',cookie:f.cookie,body:{...payload,screenshot}})).data.replayed,true);
  assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM payment_screenshots').get().n,1);
  const imagePath=`/api/orders/${order.id}/payment-screenshot`;
  assert.equal((await fetch(f.base+imagePath)).status,401);
  const otherCookie=await f.login(f.other);assert.equal((await fetch(f.base+imagePath,{headers:{Cookie:otherCookie}})).status,404);
  const image=await fetch(f.base+imagePath,{headers:{Cookie:f.cookie}});
  assert.equal(image.status,200);assert.equal(image.headers.get('content-type'),'image/png');
  assert.deepEqual(Buffer.from(await image.arrayBuffer()),Buffer.from(screenshot.data,'base64'));
  const manager=await fetch(f.base+`/api/order-management/orders/${order.id}/payment-screenshot`,{headers:{Authorization:`Bearer ${token}`}});
  assert.equal(manager.status,200);assert.equal(manager.headers.get('cache-control'),'private, no-store');
  const reopened=new SQLiteStore(f.store.path);t.after(()=>reopened.close());
  assert.deepEqual(new OrderService(reopened).getPaymentScreenshot(order.id,f.owner.id).data,Buffer.from(screenshot.data,'base64'));
});
test('旧付款可补截图，已提交凭证不可替换，商品 UPC 快照保留',async t=>{
  const f=await fixture(t),order=(await f.create({...input(),items:[{...input().items[0],upc:'194841070138',catalogId:'standard-item'}]})).data.order;
  assert.equal(order.items[0].upc,'194841070138');
  order.payment={status:'submitted',reference:'LEGACY',description:'',submittedAt:Date.now()};f.orders.store.write(order,Date.now());
  assert.equal(f.orders.submitManualPayment(order.id,f.owner,{reference:'LEGACY',description:'',screenshot}).order.payment.status,'submitted');
  const changed={...screenshot,data:Buffer.concat([Buffer.from(screenshot.data,'base64'),Buffer.from('different')]).toString('base64')};
  assert.throws(()=>f.orders.submitManualPayment(order.id,f.owner,{reference:'LEGACY',description:'',screenshot:changed}),/已提交/);
  assert.throws(()=>f.orders.submitManualPayment(order.id,f.owner,{reference:'LEGACY',description:'',screenshot:{contentType:'image/svg+xml',data:screenshot.data}}),/仅支持/);
});

test('外部订单号选填：多单留空、空格和省略均可，填写时仍防重并保持幂等',async t=>{
  const f=await fixture(t);
  const omitted=input();delete omitted.referenceId;
  for (const [index,payload] of [{...input(),referenceId:''},{...input(),referenceId:'  '},omitted].entries()) {
    const created=await f.create(payload,`blank-${index}`);assert.equal(created.status,201);assert.equal(created.data.order.referenceId,'');
    assert.equal((await f.create(payload,`blank-${index}`)).data.order.id,created.data.order.id);
  }
  assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM orders WHERE reference_id IS NULL').get().n,3);
  assert.equal((await f.create(input(),'with-reference')).status,201);
  assert.equal((await f.create(input(),'duplicate-reference')).status,409);
  assert.equal((await f.create({...input(),referenceId:'x'.repeat(101)},'long-reference')).status,400);
});

test('旧订单表迁移保留付款截图和履约任务，关联与约束仍有效',t=>{
  const dir=mkdtempSync(join(tmpdir(),'optional-reference-migration-'));
  const store=new SQLiteStore(join(dir,'accounts.sqlite'));t.after(()=>{store.close();rmSync(dir,{recursive:true,force:true})});
  store.db.exec(`CREATE TABLE orders (id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, reference_id TEXT NOT NULL, create_key TEXT NOT NULL, create_hash TEXT NOT NULL, timely_order_id TEXT UNIQUE, data TEXT NOT NULL CHECK(json_valid(data)), created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, UNIQUE(owner_id, reference_id), UNIQUE(owner_id, create_key));`);
  const legacy={...input(),id:'legacy-order',ownerId:'owner',payment:{status:'submitted',reference:'bank',screenshot:{id:'legacy-image'}},external:{status:'not_created'},events:[]};
  store.db.prepare('INSERT INTO orders VALUES(?,?,?,?,?,?,?,?,?)').run(legacy.id,legacy.ownerId,legacy.referenceId,'old-key','old-hash',null,JSON.stringify(legacy),1,1);
  store.db.exec(`CREATE TABLE linked_order (id TEXT PRIMARY KEY, order_id TEXT REFERENCES orders(id)); INSERT INTO linked_order VALUES('linked','legacy-order');`);
  store.db.exec(`
    CREATE TABLE payment_screenshots (id TEXT PRIMARY KEY, order_id TEXT NOT NULL UNIQUE REFERENCES orders(id) ON DELETE CASCADE, content_type TEXT NOT NULL, sha256 TEXT NOT NULL, data BLOB NOT NULL, created_at INTEGER NOT NULL);
    CREATE TABLE fulfillment_jobs (id TEXT PRIMARY KEY, order_id TEXT NOT NULL UNIQUE REFERENCES orders(id), status TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, next_attempt_at INTEGER NOT NULL DEFAULT 0, lease_until INTEGER NOT NULL DEFAULT 0, last_error TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
  `);
  store.db.prepare('INSERT INTO payment_screenshots VALUES(?,?,?,?,?,?)').run('legacy-image',legacy.id,'image/png','hash',Buffer.from(screenshot.data,'base64'),1);
  store.db.prepare("INSERT INTO fulfillment_jobs(id,order_id,status,created_at,updated_at) VALUES('job',?,'pending',1,1)").run(legacy.id);
  const orders=new OrderService(store);
  const account={id:'owner',providerName:'服务商',personName:'人员'};
  assert.deepEqual(orders.getPaymentScreenshot(legacy.id,account.id).data,Buffer.from(screenshot.data,'base64'));
  assert.equal(orders.get(legacy.id).referenceId,'ORDER-001');assert.equal(store.db.pragma('foreign_key_check').length,0);assert.equal(store.db.pragma('foreign_keys',{simple:true}),1);
  assert.equal(store.db.prepare('SELECT order_id FROM linked_order').get().order_id,legacy.id);
  assert.equal(store.db.prepare('SELECT count(*) AS n FROM payment_screenshots').get().n,1);assert.equal(store.db.prepare('SELECT count(*) AS n FROM fulfillment_jobs').get().n,1);
  assert.equal(orders.create(account,{...input(),referenceId:''},'new-1').created,true);assert.equal(orders.create(account,{...input(),referenceId:''},'new-2').created,true);
  assert.equal(new OrderService(store).get(legacy.id).payment.reference,'bank');
});

test('外部订单号未填写时，履约请求使用稳定的本项目订单号作为关联编号',async()=>{
  let body;
  const client=createFulfillmentClient({timelyHost:'https://example.com/',timelyKey:'key',timelySecret:'secret',timelyService:'service',timelyCreator:'creator'},async(url,options)=>{body=JSON.parse(options.body);return {ok:true,json:async()=>({id:'timely'})}});
  await client({...input(),id:'internal-order-id',referenceId:'',providerName:'服务商'},'job');assert.equal(body.referenceId,'internal-order-id');
});

test('订单商品图片快照入库，列表详情及重启读取保持图片，无图旧商品可用',async t=>{
  const f=await fixture(t),imageUrl='https://cdn.example/product.jpg';
  const payload={...input(),items:[{...input().items[0],imageUrl},input().items[0]]};
  const created=await f.create(payload);assert.equal(created.status,201);
  const order=created.data.order;assert.equal(order.items[0].imageUrl,imageUrl);assert.equal(order.items[1].imageUrl,undefined);
  assert.equal((await f.call(`/api/orders/${order.id}`,{cookie:f.cookie})).data.order.items[0].imageUrl,imageUrl);
  assert.equal((await f.call('/api/orders',{cookie:f.cookie})).data.orders[0].items[0].imageUrl,imageUrl);
  const reopened=new SQLiteStore(f.store.path);t.after(()=>reopened.close());
  assert.equal(new OrderService(reopened).get(order.id).items[0].imageUrl,imageUrl);
  for (const imageUrl of ['http://cdn.example/a.jpg','javascript:alert(1)','data:image/png;base64,AA','https://user:secret@cdn.example/a.jpg','/relative.jpg',123,null,'https://cdn.example/'+ 'x'.repeat(2048)]) {
    assert.equal((await f.create({...input(),items:[{...input().items[0],imageUrl}]},'unsafe-image')).status,400);
  }
});
test('商品展示图片不改变履约系统接收的商品字段',async()=>{
  const original=input(),items=original.items.map(item=>({...item,imageUrl:'https://cdn.example/product.jpg'}));
  const config={timelyHost:'http://127.0.0.1:9/',timelyKey:'key',timelySecret:'secret',timelyService:'service',timelyCreator:'creator'};
  let sent;
  const client=createFulfillmentClient(config,async(url,options)=>{sent=JSON.parse(options.body);return {ok:true,json:async()=>({id:'mock-order'})}});
  await client({...original,items,providerName:'测试'},'mock-job');
  assert.deepEqual(JSON.parse(sent.items),original.items);assert.equal(items[0].imageUrl,'https://cdn.example/product.jpg');
});

test('服务商与管理端接口均返回同步的备注配送信息，其他账号不能触发或读取',async t=>{
 let queries=0;const client=async()=> 'linked';client.query=async id=>{queries++;return {id,status:3,memos:[{id:'memo',content:'已安排配送'}],logiticsOrder:{id:'delivery',channel:1,status:2,deliverier:'测试配送员',mobile:'13800138000',logiticsOrderId:'TRACK-001'}}};
 const f=await fixture(t,{},client),order=(await f.create()).data.order;
 f.orders.receipt(order.id,{eventId:'sync-receipt',transactionId:'SYNC-TX',amount:2468,collectedAt:Date.now()});f.orders.review(order.id,{eventId:'sync-review',status:'approved',reviewerName:'审核人',reviewedAt:Date.now()});f.orders.link(order.id,{eventId:'sync-link',timelyOrderId:'linked',description:'模拟履约关联'});
 const other=await f.login(f.other);assert.equal((await f.call(`/api/orders/${order.id}`,{cookie:other})).status,404);assert.equal(queries,0);
 const detail=await f.call(`/api/orders/${order.id}`,{cookie:f.cookie});assert.equal(detail.status,200);assert.equal(detail.data.order.fulfillment.memos[0].content,'已安排配送');assert.equal(detail.data.order.fulfillment.deliveries[0].riderPhone,'13800138000');assert.equal(queries,1);
 const manager=await f.call('/api/order-management/orders',{management:true});assert.equal(manager.data.orders[0].fulfillment.deliveries[0].orderNo,'TRACK-001');
 assert.equal((await f.call('/api/orders',{cookie:f.cookie})).data.orders[0].fulfillment.sourceStatus,'已呼叫跑腿');
});

test('审核建单后立即同步首份配送快照，不依赖页面打开详情',async t=>{
  let creates=0,queries=0;const client=async()=>{creates++;return 'auto-linked'};client.query=async id=>{queries++;return {id,status:1,memos:[{id:'memo',content:'履约方已接单'}],logiticsOrder:null}};
  const f=await fixture(t,{},client),order=(await f.create()).data.order;
  f.orders.receipt(order.id,{eventId:'auto-receipt',transactionId:'AUTO-TX',amount:2468,collectedAt:Date.now()});
  const reviewed=await f.call(`/api/order-management/orders/${order.id}/review`,{method:'POST',management:true,body:{eventId:'auto-review',status:'approved',reviewerName:'审核人',reviewedAt:Date.now()}});assert.equal(reviewed.status,200);
  for(let index=0;index<50&&!f.orders.get(order.id).fulfillment.syncedAt;index++)await new Promise(resolve=>setTimeout(resolve,10));
  const saved=f.orders.get(order.id);assert.equal(saved.external.timelyOrderId,'auto-linked');assert.equal(saved.fulfillment.memos[0].content,'履约方已接单');assert.equal(creates,1);assert.equal(queries,1);
});


test('退回付款资料必填原因并幂等保留凭证、拒绝快照和事件，不进入审核履约',async t=>{
  const f=await fixture(t),order=(await f.create()).data.order;
  const paymentPath=`/api/orders/${order.id}/manual-payment`,managerPath=`/api/order-management/orders/${order.id}`;
  const first=(await f.call(paymentPath,{method:'POST',cookie:f.cookie,body:{reference:'PROOF-A',description:'转账资料',screenshot}})).data.order.payment;
  const rejection={eventId:'reject-A',noteId:first.noteId,reason:'截图中的收款方需要核对',reviewerName:'收款人员',rejectedAt:Date.now()};
  assert.equal((await f.call(`${managerPath}/reject-payment`,{method:'POST',management:true,body:{...rejection,reason:'  '}})).status,400);
  const rejected=await f.call(`${managerPath}/reject-payment`,{method:'POST',management:true,body:rejection});
  assert.equal(rejected.status,200);assert.equal(rejected.data.replayed,false);
  const saved=rejected.data.order;assert.equal(saved.payment.status,'unpaid');assert.equal(saved.review.status,'not_submitted');assert.equal(saved.external.status,'not_created');
  assert.deepEqual(saved.payment.rejection,{noteId:first.noteId,reason:rejection.reason,reviewerName:rejection.reviewerName,rejectedAt:rejection.rejectedAt});
  assert.deepEqual(saved.payment.rejections[0],{...saved.payment.rejection,reference:first.reference,description:first.description,screenshot:first.screenshot,submittedAt:first.submittedAt,payerId:first.payerId,payerName:first.payerName});
  const events=saved.events.length;
  const replay=await f.call(`${managerPath}/reject-payment`,{method:'POST',management:true,body:rejection});assert.equal(replay.data.replayed,true);assert.equal(replay.data.order.events.length,events);
  assert.equal((await f.call(`${managerPath}/reject-payment`,{method:'POST',management:true,body:{...rejection,reason:'不同原因'}})).status,409);
  assert.equal((await f.call(`${managerPath}/reject-payment`,{method:'POST',management:true,body:{...rejection,eventId:'second-decision'}})).status,409);
  assert.equal((await f.call(`${managerPath}/review`,{method:'POST',management:true,body:{eventId:'review-unpaid',status:'approved',reviewerName:'审核人',reviewedAt:Date.now()}})).status,409);
  assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM fulfillment_jobs').get().n,0);
  assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM management_events').get().n,1);
  assert.deepEqual(f.orders.getPaymentScreenshot(order.id,f.owner.id).data,Buffer.from(screenshot.data,'base64'));
  const reopened=new SQLiteStore(f.store.path);t.after(()=>reopened.close());assert.deepEqual(new OrderService(reopened).get(order.id).payment,saved.payment);
});

test('退回接口保持管理鉴权和账号隔离，版本、时间和输入无效时不改变数据',async t=>{
  const f=await fixture(t),order=(await f.create()).data.order;
  const first=f.orders.submitManualPayment(order.id,f.owner,{reference:'AUTH-PROOF',description:'',screenshot}).order.payment;
  const path=`/api/order-management/orders/${order.id}/reject-payment`;
  const valid={eventId:'reject-auth',noteId:first.noteId,reason:'需要补全信息',reviewerName:'核对人',rejectedAt:Date.now()};
  const otherCookie=await f.login(f.other);
  for(const options of [{},{cookie:f.cookie},{cookie:otherCookie},{management:true,key:'incorrect'}]) assert.equal((await f.call(path,{method:'POST',body:valid,...options})).status,401);
  assert.equal((await f.call(`/api/orders/${order.id}/manual-payment`,{method:'POST',cookie:otherCookie,body:{reference:'FOREIGN',screenshot}})).status,404);
  assert.equal((await f.call(`/api/orders/${order.id}`,{cookie:otherCookie})).status,404);
  assert.equal((await fetch(f.base+`/api/orders/${order.id}/payment-screenshot`,{headers:{Cookie:otherCookie}})).status,404);
  assert.equal((await f.call('/api/order-management/orders/missing/reject-payment',{method:'POST',management:true,body:valid})).status,404);
  for(const change of [{noteId:undefined},{reason:''},{reviewerName:''},{rejectedAt:0},{rejectedAt:Date.now()+600000}]) assert.equal((await f.call(path,{method:'POST',management:true,body:{...valid,...change}})).status,400);
  for(const change of [{noteId:'another-submission'},{rejectedAt:first.submittedAt-1}]) assert.equal((await f.call(path,{method:'POST',management:true,body:{...valid,...change}})).status,409);
  const second=(await f.create({...input(),referenceId:'AUTH-SECOND'},'auth-second')).data.order;
  assert.equal((await f.call(`/api/order-management/orders/${second.id}/reject-payment`,{method:'POST',management:true,body:valid})).status,409);
  assert.deepEqual(f.orders.get(order.id).payment,first);assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM management_events').get().n,0);
});

test('退回后重提需匹配previousNoteId，旧提交与旧退回重放不能覆盖新资料，同图也可重提',async t=>{
  const f=await fixture(t),order=(await f.create()).data.order,body={reference:'SAME-PROOF',description:'重新核对原图',screenshot};
  const path=`/api/orders/${order.id}/manual-payment`,rejectPath=`/api/order-management/orders/${order.id}/reject-payment`;
  const send=payload=>f.call(path,{method:'POST',cookie:f.cookie,body:payload});
  const first=(await send(body)).data.order.payment;
  assert.equal((await send(body)).data.replayed,true);
  const rejectA={eventId:'version-reject-A',noteId:first.noteId,reason:'核对付款人',reviewerName:'核对人',rejectedAt:Date.now()};
  assert.equal((await f.call(rejectPath,{method:'POST',management:true,body:rejectA})).status,200);
  for(const payload of [body,{...body,previousNoteId:'stale'}]) assert.equal((await send(payload)).status,409);
  await new Promise(resolve=>setTimeout(resolve,2));
  const secondResult=await send({...body,previousNoteId:first.noteId});assert.equal(secondResult.status,200);
  const second=secondResult.data.order.payment;assert.equal(secondResult.data.replayed,false);assert.notEqual(second.noteId,first.noteId);assert.ok(second.submittedAt>first.submittedAt);
  assert.equal(second.previousNoteId,first.noteId);assert.equal(second.rejection,undefined);assert.equal(second.rejections.length,1);
  assert.equal((await send({...body,previousNoteId:first.noteId})).data.replayed,true);
  for(const payload of [body,{...body,previousNoteId:second.noteId},{...body,previousNoteId:first.noteId,description:'不同内容'}]) assert.equal((await send(payload)).status,409);
  const replayA=await f.call(rejectPath,{method:'POST',management:true,body:rejectA});assert.equal(replayA.data.replayed,true);assert.equal(replayA.data.order.payment.noteId,second.noteId);assert.equal(replayA.data.order.payment.status,'submitted');
  const rejectB={...rejectA,eventId:'version-reject-B',noteId:second.noteId,rejectedAt:Date.now()};
  assert.equal((await f.call(rejectPath,{method:'POST',management:true,body:rejectB})).status,200);
  assert.equal((await send({...body,previousNoteId:first.noteId})).status,409);
  const third=(await send({...body,previousNoteId:second.noteId})).data.order.payment;assert.notEqual(third.noteId,second.noteId);assert.equal(third.rejections.length,2);
  assert.deepEqual(third.rejections.map(x=>x.noteId),[first.noteId,second.noteId]);
  assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM payment_screenshots WHERE order_id=?').get(order.id).n,3);
  assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM fulfillment_jobs').get().n,0);
});

test('退回后的陈旧确认和拒绝均被阻止，正确轮次确认幂等且只进入收款待审核',async t=>{
  const f=await fixture(t),order=(await f.create()).data.order,path=`/api/order-management/orders/${order.id}`;
  const first=f.orders.submitManualPayment(order.id,f.owner,{reference:'PROOF-FIRST',description:'初次',screenshot}).order.payment;
  const receipt={eventId:'stale-receipt',noteId:first.noteId,transactionId:'FINAL-TX',amount:2468,collectedAt:Date.now()};
  f.orders.rejectPayment(order.id,{eventId:'stale-reject-A',noteId:first.noteId,reason:'请补全信息',reviewerName:'核对人',rejectedAt:Date.now()});
  assert.equal((await f.call(`${path}/receipt`,{method:'POST',management:true,body:receipt})).status,409);
  assert.equal((await f.call(`${path}/receipt`,{method:'POST',management:true,body:{...receipt,noteId:undefined}})).status,409);
  await new Promise(resolve=>setTimeout(resolve,2));
  const replacement={...screenshot,data:Buffer.concat([Buffer.from(screenshot.data,'base64'),Buffer.from('replacement-proof')]).toString('base64')};
  const second=f.orders.submitManualPayment(order.id,f.owner,{reference:'PROOF-SECOND',description:'补全资料',screenshot:replacement,previousNoteId:first.noteId}).order.payment;
  assert.notEqual(second.screenshot.id,first.screenshot.id);
  assert.deepEqual(f.orders.getPaymentScreenshot(order.id,f.owner.id).data,Buffer.from(replacement.data,'base64'));
  const managerImage=await fetch(f.base+`${path}/payment-screenshot`,{headers:{Authorization:`Bearer ${token}`}});assert.deepEqual(Buffer.from(await managerImage.arrayBuffer()),Buffer.from(replacement.data,'base64'));
  assert.deepEqual(f.store.db.prepare('SELECT data FROM payment_screenshots WHERE id=?').get(first.screenshot.id).data,Buffer.from(screenshot.data,'base64'));
  for(const change of [{},{noteId:undefined}]) assert.equal((await f.call(`${path}/receipt`,{method:'POST',management:true,body:{...receipt,...change}})).status,409);
  assert.equal((await f.call(`${path}/reject-payment`,{method:'POST',management:true,body:{eventId:'old-decision-new-event',noteId:first.noteId,reason:'陈旧页面',reviewerName:'核对人',rejectedAt:Date.now()}})).status,409);
  const confirmed={...receipt,noteId:second.noteId,collectedAt:second.submittedAt-60000};
  assert.equal((await f.call(`${path}/receipt`,{method:'POST',management:true,body:confirmed})).status,200);
  assert.equal((await f.call(`${path}/receipt`,{method:'POST',management:true,body:confirmed})).data.replayed,true);
  assert.equal((await f.call(`${path}/receipt`,{method:'POST',management:true,body:{...confirmed,noteId:first.noteId}})).status,409);
  assert.equal((await f.call(`${path}/reject-payment`,{method:'POST',management:true,body:{eventId:'reject-paid',noteId:second.noteId,reason:'不能退回已收款',reviewerName:'核对人',rejectedAt:Date.now()}})).status,409);
  const saved=f.orders.get(order.id);assert.equal(saved.payment.status,'paid');assert.equal(saved.review.status,'pending');assert.equal(saved.payment.rejections.length,1);assert.equal(saved.external.status,'not_created');
  assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM fulfillment_jobs').get().n,0);
});

test('确认与退回同一付款资料并发时只有一个决策成功，不会产生履约任务',async t=>{
  const f=await fixture(t);
  for(const rejectFirst of [false,true]) {
    const order=(await f.create({...input(),referenceId:`RACE-${rejectFirst}`},`race-${rejectFirst}`)).data.order;
    const proof=f.orders.submitManualPayment(order.id,f.owner,{reference:'RACE',description:'',screenshot}).order.payment;
    const base=`/api/order-management/orders/${order.id}`,time=Date.now();
    const calls=[()=>f.call(`${base}/receipt`,{method:'POST',management:true,body:{eventId:`race-confirm-${rejectFirst}`,noteId:proof.noteId,transactionId:`RACE-TX-${rejectFirst}`,amount:2468,collectedAt:time}}),()=>f.call(`${base}/reject-payment`,{method:'POST',management:true,body:{eventId:`race-reject-${rejectFirst}`,noteId:proof.noteId,reason:'资料有误',reviewerName:'核对人',rejectedAt:time}})];
    if(rejectFirst) calls.reverse();
    const results=await Promise.all(calls.map(run=>run()));assert.deepEqual(results.map(x=>x.status).sort(),[200,409]);
    const saved=f.orders.get(order.id);assert.ok(['paid','unpaid'].includes(saved.payment.status));
    assert.equal(saved.review.status,saved.payment.status==='paid'?'pending':'not_submitted');
    assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM management_events WHERE order_id=?').get(order.id).n,1);
    assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM fulfillment_jobs WHERE order_id=?').get(order.id).n,0);
  }
});

test('旧补图保持本轮noteId和提交时间，未退回旧收款接口兼容但可选noteId仍校验',async t=>{
  const f=await fixture(t),order=(await f.create()).data.order,submittedAt=Date.now()-1000;
  order.payment={status:'submitted',noteId:'legacy-payment',reference:'LEGACY-PROOF',description:'',submittedAt};f.orders.store.write(order,Date.now());
  const supplemented=f.orders.submitManualPayment(order.id,f.owner,{reference:'LEGACY-PROOF',description:'',screenshot}).order.payment;
  assert.equal(supplemented.noteId,'legacy-payment');assert.equal(supplemented.submittedAt,submittedAt);
  const receipt={eventId:'legacy-receipt',transactionId:'LEGACY-TX',amount:2468,collectedAt:Date.now()};
  assert.throws(()=>f.orders.receipt(order.id,{...receipt,noteId:'other'}),/付款资料已更新/);
  assert.equal(f.orders.receipt(order.id,receipt).order.payment.status,'paid');assert.equal(f.orders.receipt(order.id,receipt).replayed,true);
  const second=(await f.create({...input(),referenceId:'LEGACY-UNPAID'},'legacy-unpaid')).data.order;
  assert.equal(f.orders.receipt(second.id,{...receipt,eventId:'legacy-direct',transactionId:'LEGACY-DIRECT'}).order.payment.status,'paid');
});

test('旧一单一图迁移保留BLOB和审计，允许一单多次提交，重复迁移安全且约束仍在',t=>{
  const dir=mkdtempSync(join(tmpdir(),'payment-history-migration-')),path=join(dir,'accounts.sqlite');let store=new SQLiteStore(path);
  t.after(()=>{store.close();rmSync(dir,{recursive:true,force:true})});
  let orders=new OrderService(store);const owner={id:'migration-owner',providerName:'测试',personName:'测试人'};
  const created=orders.create(owner,input(),'migration-create').order;
  store.db.exec(`DROP TABLE payment_screenshots; CREATE TABLE payment_screenshots (id TEXT PRIMARY KEY, order_id TEXT NOT NULL UNIQUE REFERENCES orders(id) ON DELETE CASCADE, content_type TEXT NOT NULL, sha256 TEXT NOT NULL, data BLOB NOT NULL CHECK(length(data) BETWEEN 1 AND 5242880), created_at INTEGER NOT NULL);`);
  const first=orders.submitManualPayment(created.id,owner,{reference:'MIGRATION-PROOF',description:'保留原图',screenshot}).order.payment;
  const original=store.db.prepare('SELECT * FROM payment_screenshots').get(),data=orders.get(created.id);
  store.db.prepare('INSERT INTO management_events VALUES(?,?,?,?,?)').run('historical-audit',created.id,'audit','historical-hash',1);
  store.close();store=new SQLiteStore(path);orders=new OrderService(store);
  assert.deepEqual(orders.get(created.id),data);assert.deepEqual(store.db.prepare('SELECT * FROM payment_screenshots').get(),original);
  assert.equal(store.db.prepare('SELECT payload_hash FROM management_events').get().payload_hash,'historical-hash');
  assert.equal(store.db.pragma('foreign_key_check').length,0);assert.equal(store.db.pragma('foreign_keys',{simple:true}),1);
  orders.rejectPayment(created.id,{eventId:'migration-reject',noteId:first.noteId,reason:'重新确认',reviewerName:'核对人',rejectedAt:Date.now()});
  const second=orders.submitManualPayment(created.id,owner,{reference:'MIGRATION-PROOF',description:'保留原图',screenshot,previousNoteId:first.noteId}).order.payment;
  assert.notEqual(second.screenshot.id,first.screenshot.id);assert.equal(store.db.prepare('SELECT count(*) AS n FROM payment_screenshots').get().n,2);
  assert.deepEqual(orders.getPaymentScreenshot(created.id,owner.id).data,original.data);
  assert.throws(()=>store.db.prepare('INSERT INTO payment_screenshots VALUES(?,?,?,?,?,?)').run('empty',created.id,'image/png','hash',Buffer.alloc(0),1),/CHECK/);
  assert.throws(()=>store.db.prepare('INSERT INTO payment_screenshots VALUES(?,?,?,?,?,?)').run('foreign','missing','image/png','hash',original.data,1),/FOREIGN KEY/);
  assert.throws(()=>store.db.prepare('INSERT INTO payment_screenshots VALUES(?,?,?,?,?,?)').run(first.screenshot.id,created.id,'image/png','hash',original.data,1),/UNIQUE/);
  new OrderService(store);assert.equal(store.db.prepare('SELECT count(*) AS n FROM payment_screenshots').get().n,2);assert.equal(store.db.pragma('foreign_key_check').length,0);
});
