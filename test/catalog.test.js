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

test('多词搜索对原始商品字段做无序 AND，并按实际匹配跨候选页分页', async () => {
  const calls = [];
  const match = id => ({ id, officialName: '商品 ' + id, searchIndex: 'ＭＯＩＳＴＵＲＩＺＥＲ', aliasName: '保湿',
    salesName: '晚霜', brand: { officialName: '品牌甲' }, spec: { name: '旅行装' }, volume: 150, volumeUnit: 'ML' });
  const noise = id => ({ id, officialName: '商品 ' + id, searchIndex: 'moisturizer', aliasName: '保湿' });
  const firstBatch = [match('first'), ...Array.from({ length: 99 }, (_, index) => noise('noise-a-' + index))];
  const middleMatches = Array.from({ length: 21 }, (_, index) => match('middle-' + index));
  const secondBatch = [match('first'), ...middleMatches, ...Array.from({ length: 78 }, (_, index) => noise('noise-b-' + index))];
  const thirdBatch = [noise('noise-c'), match('last')];
  const batches = [firstBatch, secondBatch, thirdBatch];
  const search = createCatalogClient(config, async url => {
    calls.push(new URL(url));
    return { ok: true, json: async () => batches[Number(url.searchParams.get('page'))] };
  });
  const query = '保湿　１５０ｍｌ  品牌甲 晚霜 旅行装 MOISTURIZER 保湿';
  const first = await search({ query });
  assert.deepEqual(first.products.map(row => row.id), ['first', ...middleMatches.slice(0, 19).map(row => row.id)]);
  assert.equal(first.page, 1);
  assert.equal(first.hasMore, true);
  assert.equal(Object.hasOwn(first, 'limited'), false);
  assert.deepEqual(calls.map(url => url.searchParams.get('page')), ['0', '1']);
  assert.deepEqual(await search({ query: 'moisturizer 旅行装 晚霜 品牌甲 150ml 保湿' }), first);

  const second = await search({ query, page: '2' });
  assert.deepEqual(second.products.map(row => row.id), ['middle-19', 'middle-20', 'last']);
  assert.equal(second.page, 2);
  assert.equal(second.hasMore, false);
  assert.equal(Object.hasOwn(second, 'limited'), false);
  assert.deepEqual(calls.slice(4).map(url => url.searchParams.get('page')), ['0', '1', '2']);
  for (const url of calls) {
    assert.equal(url.searchParams.get('searchIndex'), 'moisturizer');
    assert.equal(url.searchParams.get('pageSize'), '100');
    assert.equal(url.searchParams.get('status'), '0');
    assert.equal(url.searchParams.get('upc'), '');
    assert.equal(url.searchParams.get('sign').length, 64);
  }
});

test('等长关键词使用固定候选锚，去重为单词时复用原查询', async () => {
  const calls = [];
  const search = createCatalogClient(config, async url => {
    calls.push(new URL(url));
    return { ok: true, json: async () => [] };
  });
  await search({ query: 'SERUM Cream' });
  await search({ query: 'Cream serum' });
  await search({ query: 'Ｃｒｅａｍ cream', page: '3' });
  assert.deepEqual(calls.map(url => url.searchParams.get('searchIndex')), ['cream', 'cream', 'cream']);
  assert.deepEqual(calls.map(url => url.searchParams.get('pageSize')), ['100', '100', '20']);
  assert.equal(calls[2].searchParams.get('page'), '2');
});

test('容量词留在本地匹配，上游候选优先使用商品或品牌词', async () => {
  const rows = [
    { id: '30ml', officialName: '修护精华', searchIndex: '兰蔻|01-30-ml-14t', volume: 30, volumeUnit: 'ml' },
    { id: '200g', officialName: '保湿面霜', searchIndex: '兰蔻|02-200-g-14t', volume: 200, volumeUnit: 'g' },
    { id: '1.5l', officialName: '旅行套装', searchIndex: '兰蔻|03-1.5-L-14t', volume: 1.5, volumeUnit: 'L' },
  ];
  const search = createCatalogClient(config, async url => {
    const anchor = url.searchParams.get('searchIndex');
    assert.equal(anchor, '兰蔻');
    return { ok: true, json: async () => rows.filter(row => row.searchIndex.includes(anchor)) };
  });
  for (const id of ['30ml', '200g', '1.5l']) {
    const result = await search({ query: id + ' 兰蔻' });
    assert.deepEqual(result.products.map(row => row.id), [id]);
  }
});

test('多词候选扫描到上限返回有限结果，上游故障仍是原错误', async () => {
  const calls = [];
  const search = createCatalogClient(config, async url => {
    const page = Number(url.searchParams.get('page'));
    calls.push(page);
    return { ok: true, json: async () => Array.from({ length: 100 }, (_, index) => ({
      id: page + '-' + index, officialName: index === 0 ? '晚霜 moisturizer' : 'moisturizer',
    })) };
  });
  const result = await search({ query: '晚霜 moisturizer' });
  assert.deepEqual(calls, [0, 1, 2, 3, 4, 5, 6, 7]);
  assert.deepEqual(result.products.map(row => row.id), calls.map(page => page + '-0'));
  assert.equal(result.hasMore, false);
  assert.equal(result.limited, true);
  const failing = createCatalogClient(config, async url => url.searchParams.get('page') === '0'
    ? { ok: true, json: async () => Array(100).fill({ id: 'item', officialName: 'moisturizer' }) }
    : { ok: true, json: async () => ({ error: true }) });
  await assert.rejects(failing({ query: '晚霜 moisturizer' }), /商品库查询失败/);
});

test('多词候选扫描共享超时预算，超时保留已确认的匹配', async t => {
  const controller = new AbortController();
  const timers = t.mock.method(AbortSignal, 'timeout', () => controller.signal);
  const search = createCatalogClient(config, async (url, options) => {
    assert.equal(options.signal, controller.signal);
    if (url.searchParams.get('page') === '0') {
      const match = { id: 'match', officialName: '晚霜 moisturizer' };
      const noise = { id: 'noise', officialName: 'moisturizer' };
      return { ok: true, json: async () => [match, ...Array(99).fill(noise)] };
    }
    controller.abort(new DOMException('查询超时', 'TimeoutError'));
    throw options.signal.reason;
  });
  const result = await search({ query: '晚霜 moisturizer' });
  assert.equal(timers.mock.callCount(), 1);
  assert.deepEqual(result.products.map(row => row.id), ['match']);
  assert.equal(result.hasMore, false);
  assert.equal(result.limited, true);
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
