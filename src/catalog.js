import { signParams } from './fulfillment.js';
import { AppError } from './service.js';
function productImage(row) {
  for (const value of [row.mainCover, ...(Array.isArray(row.salesCovers) ? row.salesCovers : [])]) {
    if (typeof value !== 'string' || !value.trim()) continue;
    try {
      const url = new URL(value.trim());
      if (url.protocol === 'https:' && !url.username && !url.password) return url.href;
    } catch {}
  }
  return '';
}
export function createCatalogClient(config, fetchImpl = fetch) {
  return async ({ query = '', page = '1' } = {}) => {
    const keyword = typeof query === 'string' ? query.trim() : '';
    const number = Number(page);
    if ((keyword && keyword.length < 2) || keyword.length > 100) throw new AppError(400, '请输入 2 至 100 字的商品名称或 UPC 码');
    if (!Number.isInteger(number) || number < 1 || number > 1000) throw new AppError(400, '商品查询页码不正确');
    if (!config.standardHost || !config.standardKey || !config.standardSecret) throw new AppError(503, '商品库尚未配置');
    const byUpc = /^\d{6,18}$/.test(keyword);
    const params = { page: number - 1, pageSize: 20, status: 0, upc: byUpc ? keyword : '', ...(!byUpc && keyword ? { searchIndex: keyword } : {}) };
    const url = new URL('admin/items/', config.standardHost.replace(/\/$/,'') + '/');
    Object.entries(signParams(params,config.standardKey,config.standardSecret)).forEach(([key,value])=>url.searchParams.set(key,String(value)));
    let payload;
    try {
      const response = await fetchImpl(url, {redirect:'error',signal:AbortSignal.timeout(10000)});
      if (!response.ok) throw new Error();
      payload = await response.json();
    } catch { throw new AppError(502, '商品库暂时无法连接，请重试'); }
    if (payload?.error) throw new AppError(502, '商品库查询失败，请稍后重试');
    const rows = payload?.data || payload;
    if (!Array.isArray(rows)) throw new AppError(502, '商品库响应异常');
    const visible = rows.slice(0,20);
    const products = visible.filter(row=>row && row.id && typeof row.officialName === 'string').map(row=>({
      id:String(row.id), name:row.officialName.trim(), upc:row.upc ? String(row.upc) : '',
      spec:[row.spec?.name, row.volume ? String(row.volume) + (row.volumeUnit || '') : ''].filter(Boolean).join(' / '),
      price:Number.isSafeInteger(row.price) && row.price > 0 ? row.price : null,
      brandName:typeof row.brand?.officialName === 'string' ? row.brand.officialName.trim() : '',
      brandId:typeof row.brand?.id === 'string' ? row.brand.id : '', imageUrl:productImage(row),
    }));
    return {products,page:number,hasMore:rows.length === 20};
  };
}
