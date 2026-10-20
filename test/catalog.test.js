import test from 'node:test';
import assert from 'node:assert/strict';
import { createCatalogClient } from '../src/catalog.js';
import { parseScreenshot, MAX_SCREENSHOT_BYTES } from '../src/payment-screenshot.js';
const config={standardHost:'https://catalog.example/base/',standardKey:'key',standardSecret:'secret'};
test('标准商品列表统一支持浏览、名称和 UPC，固定状态分页且不返回签名密钥',async()=>{
  const calls=[];
  const search=createCatalogClient(config,async url=>{calls.push(new URL(url));return{ok:true,json:async()=>[{id:'product',officialName:'测试商品 ',upc:'001234567890',price:1234,spec:{name:'标准'},volume:10,volumeUnit:'ml',brand:{officialName:'测试品牌'}}]}});
  const result=await search({query:'测试商品',page:'2'});
  assert.equal(calls[0].pathname,'/base/admin/items/');assert.equal(calls[0].searchParams.get('page'),'1');assert.equal(calls[0].searchParams.get('searchIndex'),'测试商品');
  assert.equal(result.products[0].price,1234);assert.equal(result.products[0].name,'测试商品');assert.equal(result.products[0].spec,'标准 / 10ml');
  await search({query:'001234567890'});assert.equal(calls[1].pathname,'/base/admin/items/');assert.equal(calls[1].searchParams.get('upc'),'001234567890');assert.equal(calls[1].searchParams.get('status'),'0');assert.equal(calls[1].searchParams.get('page'),'0');assert.equal(calls[1].searchParams.has('upcs'),false);assert.equal(calls[1].searchParams.get('sign').length,64);
  assert.equal(JSON.stringify(result).includes('secret'),false);
  await search({query:'',page:'3'});assert.equal(calls[2].pathname,'/base/admin/items/');assert.equal(calls[2].searchParams.get('page'),'2');assert.equal(calls[2].searchParams.get('pageSize'),'20');assert.equal(calls[2].searchParams.get('upc'),'');assert.equal(calls[2].searchParams.get('status'),'0');assert.equal(calls[2].searchParams.has('searchIndex'),false);
  await assert.rejects(createCatalogClient({})({query:''}),/尚未配置/);
  await assert.rejects(search({query:'a'}),/2 至 100/);await assert.rejects(search({query:'商品',page:'0'}),/页码/);
});
test('上游业务失败不能变成搜索成功，截图大小和数据严格限制',async()=>{
  await assert.rejects(createCatalogClient(config,async()=>({ok:true,json:async()=>({error:true})}))({query:'商品'}),/查询失败/);
  assert.throws(()=>parseScreenshot({contentType:'image/png',data:Buffer.alloc(MAX_SCREENSHOT_BYTES+1).toString('base64')}),/5 MB/);
  assert.throws(()=>parseScreenshot({contentType:'image/png',data:'!!!!'}),/数据不正确/);
  assert.throws(()=>parseScreenshot({contentType:'constructor',data:Buffer.from('not-an-image').toString('base64')}),/仅支持/);
});

test('商品带回品牌和 HTTPS 主图，缺图使用销售图，忽略非 HTTPS 和带凭据的地址',async()=>{
  const rows=[
    {id:'cover',officialName:'商品',brand:{id:'standard-brand',officialName:' 品牌 '},mainCover:'https://cdn.example/main.jpg'},
    {id:'fallback',officialName:'商品',mainCover:'',salesCovers:['javascript:alert(1)','https://cdn.example/fallback.jpg']},
    {id:'missing',officialName:'商品',mainCover:'http://cdn.example/insecure.jpg',salesCovers:['https://user:secret@cdn.example/private.jpg']},
  ];
  const result=await createCatalogClient(config,async()=>({ok:true,json:async()=>rows}))({query:''});
  assert.equal(result.products[0].imageUrl,'https://cdn.example/main.jpg');assert.equal(result.products[0].brandId,'standard-brand');assert.equal(result.products[0].brandName,'品牌');
  assert.equal(result.products[1].imageUrl,'https://cdn.example/fallback.jpg');assert.equal(result.products[2].imageUrl,'');
});
