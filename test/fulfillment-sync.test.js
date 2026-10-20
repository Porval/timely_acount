import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {SQLiteStore} from '../src/store.js';
import {AccountService} from '../src/service.js';
import {OrderService,stage} from '../src/order-service.js';
import {FulfillmentSynchronizer} from '../src/fulfillment-sync.js';
const snapshot=()=>({id:'linked',status:4,updatedAt:'2026-10-20T10:00:00Z',messages:'门口联系',memos:[{id:'memo',content:'已核对收件地址',createdAt:'2026-10-20T10:00:00Z',secret:'must-not-copy'}],logiticsOrder:{id:'delivery',timelyOrder:{id:'linked'},status:3,channel:1,logiticsOrderId:'SHANSONG-001',deliverier:'测试配送员',mobile:'13800138000',deliveryTips:'预计十分钟到达',fromName:'测试专柜',fromPhone:'13900139000',fromDetailAddress:'测试取件地址',toName:'测试收件人',toPhone:'13700137000',toDetailAddress:'测试收件地址',token:'must-not-copy'}});
function fixture(t){
 const dir=mkdtempSync(join(tmpdir(),'fulfillment-sync-')),path=join(dir,'accounts.sqlite'),store=new SQLiteStore(path);
 let tick=Date.parse('2026-10-20T11:00:00Z');
 const accounts=new AccountService({store,sendSms:async()=>{}}),owner=accounts.createAccount({providerName:'测试',personName:'测试人员',mobile:'13800138000'}),orders=new OrderService(store,()=>tick);
 const create=(reference='REF')=>orders.create(owner,{cityId:'city',cityName:'上海',brandId:'brand',brandName:'品牌',plateId:'plate',platformName:'平台',items:[{itemName:'测试商品',spec:'',salesPrice:100,quantity:1}],contacts:'原始收件信息',messages:'原始订单备注',referenceId:reference,payPrice:100,arrivedTime:30},'test-create-'+reference).order;
 const order=create();orders.receipt(order.id,{eventId:'receipt',transactionId:'TX',amount:100,collectedAt:tick});orders.review(order.id,{eventId:'review',status:'approved',reviewerName:'审核人',reviewedAt:tick});orders.link(order.id,{eventId:'link',timelyOrderId:'linked',description:'模拟已关联'});
 t.after(()=>{store.close();rmSync(dir,{recursive:true,force:true})});
 return {store,orders,order,path,owner,create,advance:(milliseconds=15000)=>{tick+=milliseconds}};
}
test('状态不变时仍同步备注和配送信息，去重事件并持久化白名单字段',t=>{
 const f=fixture(t),data=snapshot();f.orders.syncFulfillment(f.order.id,data);
 let order=f.orders.get(f.order.id);assert.equal(order.fulfillment.sourceStatus,'配送中');assert.equal(order.fulfillment.deliveries[0].riderName,'测试配送员');assert.equal(order.messages,'原始订单备注');assert.equal(order.contacts,'原始收件信息');assert.equal(JSON.stringify(order).includes('must-not-copy'),false);
 const eventCount=order.events.length;f.advance();f.orders.syncFulfillment(order.id,data);assert.equal(f.orders.get(order.id).events.length,eventCount);
 data.memos[0].content='改为侧门交接';data.logiticsOrder.mobile='13600136000';data.logiticsOrder.deliveryTips='配送员已到达';f.advance();f.orders.syncFulfillment(order.id,data);
 order=f.orders.get(order.id);assert.equal(order.fulfillment.memos[0].content,'改为侧门交接');assert.equal(order.fulfillment.deliveries[0].riderPhone,'13600136000');assert.equal(order.events.length,eventCount+1);
 const reopened=new SQLiteStore(f.path);try{assert.deepEqual(new OrderService(reopened).get(order.id).fulfillment,order.fulfillment)}finally{reopened.close()}
 data.memos=[];data.logiticsOrder=null;f.orders.syncFulfillment(order.id,data);assert.deepEqual(f.orders.get(order.id).fulfillment.deliveries,[]);assert.deepEqual(f.orders.get(order.id).fulfillment.memos,[]);
});
test('错误关联和旧快照不覆盖已有履约资料，退款及异常不会显示成已完成',t=>{
 const f=fixture(t),data=snapshot();f.orders.syncFulfillment(f.order.id,data);
 assert.throws(()=>f.orders.syncFulfillment(f.order.id,{...data,id:'other'}),/不匹配/);
 assert.throws(()=>f.orders.syncFulfillment(f.order.id,{...data,logiticsOrder:{...data.logiticsOrder,timelyOrder:{id:'other'}}}),/不匹配/);
 f.orders.syncFulfillment(f.order.id,{...data,status:0,updatedAt:'2026-10-19T10:00:00Z'});assert.equal(f.orders.get(f.order.id).fulfillment.sourceCode,4);
 for(const [status,label] of [[5,'已完成'],[6,'已退款'],[8,'履约异常']]){f.orders.syncFulfillment(f.order.id,{...data,status});assert.equal(stage(f.orders.get(f.order.id)),label);assert.equal(f.orders.list(null,{stage:label}).total,1)}
 f.orders.syncFulfillment(f.order.id,{...data,hungup:true});assert.equal(stage(f.orders.get(f.order.id)),'已挂起');
});
test('无需打开详情即可后台同步，失败保留原资料，冷却后恢复，未审核订单不查询',async t=>{
 const f=fixture(t);f.create('UNPAID');let calls=0,fail=false,data=snapshot();
 const sync=new FulfillmentSynchronizer(f.orders,{query:async id=>{calls++;assert.equal(id,'linked');if(fail)throw new Error('temporary');return data}});t.after(()=>sync.close());
 await sync.runOnce();assert.equal(calls,1);assert.equal(f.orders.list(f.owner.id).orders.find(o=>o.id===f.order.id).fulfillment.memos[0].content,'已核对收件地址');
 await sync.runOnce();assert.equal(calls,1);
 f.advance();fail=true;await sync.runOnce();let order=f.orders.get(f.order.id);assert.equal(order.fulfillment.deliveries[0].orderNo,'SHANSONG-001');assert.match(order.fulfillment.syncMessage,/保留上次记录/);
 await sync.runOnce();assert.equal(calls,2);f.advance();fail=false;data={...data,memos:[{id:'memo',content:'新备注'}]};await sync.runOnce();order=f.orders.get(f.order.id);assert.equal(order.fulfillment.memos[0].content,'新备注');assert.equal(order.fulfillment.syncMessage,undefined);
});
test('详情和后台同时同步同一订单只发一次请求，状态回传保留备注与配送快照',async t=>{
 const f=fixture(t);let release,calls=0;
 const sync=new FulfillmentSynchronizer(f.orders,{query:()=>{calls++;return new Promise(resolve=>{release=resolve})}});t.after(()=>sync.close());
 const first=sync.refresh(f.order.id),second=sync.refresh(f.order.id,{force:true});await Promise.resolve();assert.equal(calls,1);release(snapshot());await Promise.all([first,second]);
 f.advance();f.orders.fulfillment(f.order.id,{eventId:'delivered',timelyOrderId:'linked',status:'delivered',occurredAt:f.orders.now()});
 const order=f.orders.get(f.order.id);assert.equal(order.fulfillment.memos[0].content,'已核对收件地址');assert.equal(order.fulfillment.deliveries[0].riderName,'测试配送员');assert.equal(stage(order),'已完成');
});
