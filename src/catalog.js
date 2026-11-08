import { signParams } from './fulfillment.js';
import { AppError } from './service.js';

const pageSize = 20;
const candidatePageSize = 100;
const maxCandidatePages = 8;
const scanTimeoutMs = 8000;
const normalize = value => value.normalize('NFKC').toLowerCase();
const measurement = /^\d+(?:\.\d+)?(?:ml|cl|dl|l|mg|g|kg|oz|fl\.?oz|毫升|升|毫克|克|千克|公斤)$/;

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

const isProduct = row => row && row.id && typeof row.officialName === 'string';

function product(row) {
  return {
    id:String(row.id), name:row.officialName.trim(), upc:row.upc ? String(row.upc) : '',
    spec:[row.spec?.name, row.volume ? String(row.volume) + (row.volumeUnit || '') : ''].filter(Boolean).join(' / '),
    price:Number.isSafeInteger(row.price) && row.price > 0 ? row.price : null,
    brandName:typeof row.brand?.officialName === 'string' ? row.brand.officialName.trim() : '',
    brandId:typeof row.brand?.id === 'string' ? row.brand.id : '', imageUrl:productImage(row),
  };
}

function matchesWords(row, words) {
  const volume = row.volume ? String(row.volume) + String(row.volumeUnit || '').trim() : '';
  const fields = [row.searchIndex, row.officialName, row.aliasName, row.salesName, row.innerCode,
    row.brand?.officialName, row.brand?.chineseName, row.spec?.name, row.upc, row.volume, row.volumeUnit, volume];
  const searchable = normalize(fields.filter(value => typeof value === 'string' || typeof value === 'number').join('\n'));
  return words.every(word => searchable.includes(word));
}

export function createCatalogClient(config, fetchImpl = fetch) {
  const readPage = async (page, size, { upc = '', searchIndex = '', scanSignal } = {}) => {
    const params = { page, pageSize: size, status: 0, upc, ...(searchIndex ? { searchIndex } : {}) };
    const url = new URL('admin/items/', config.standardHost.replace(/\/$/,'') + '/');
    Object.entries(signParams(params,config.standardKey,config.standardSecret)).forEach(([key,value])=>url.searchParams.set(key,String(value)));
    let payload;
    try {
      const response = await fetchImpl(url, {redirect:'error',signal:scanSignal ?? AbortSignal.timeout(10000)});
      if (!response.ok) throw new Error();
      payload = await response.json();
    } catch (error) {
      if (scanSignal?.aborted && (error === scanSignal.reason || ['AbortError', 'TimeoutError'].includes(error?.name))) return null;
      throw new AppError(502, '商品库暂时无法连接，请重试');
    }
    if (payload?.error) throw new AppError(502, '商品库查询失败，请稍后重试');
    const rows = payload?.data || payload;
    if (!Array.isArray(rows)) throw new AppError(502, '商品库响应异常');
    return rows;
  };

  const searchWords = async (words, page) => {
    const ordered = [...words].sort().sort((first, second) => second.length - first.length);
    // The upstream index may represent a capacity as "30-ml" even if the displayed capacity is "30ml".
    const anchor = ordered.find(word => !measurement.test(word)) ?? ordered[0];
    const scanSignal = AbortSignal.timeout(scanTimeoutMs);
    const offset = (page - 1) * pageSize;
    const seen = new Set();
    const products = [];
    for (let candidatePage = 0; candidatePage < maxCandidatePages && !scanSignal.aborted; candidatePage++) {
      const rows = await readPage(candidatePage, candidatePageSize, { searchIndex: anchor, scanSignal });
      if (!rows) break;
      for (const row of rows.slice(0, candidatePageSize)) {
        if (!isProduct(row) || seen.has(String(row.id)) || !matchesWords(row, words)) continue;
        seen.add(String(row.id));
        if (seen.size <= offset) continue;
        if (products.length === pageSize) return { products, page, hasMore: true };
        products.push(product(row));
      }
      if (rows.length < candidatePageSize) return { products, page, hasMore: false };
    }
    return { products, page, hasMore: false, limited: true };
  };

  return async ({ query = '', page = '1' } = {}) => {
    const keyword = typeof query === 'string' ? query.trim() : '';
    const number = Number(page);
    if ((keyword && keyword.length < 2) || keyword.length > 100) throw new AppError(400, '请输入 2 至 100 字的商品名称或 UPC 码');
    if (!Number.isInteger(number) || number < 1 || number > 1000) throw new AppError(400, '商品查询页码不正确');
    if (!config.standardHost || !config.standardKey || !config.standardSecret) throw new AppError(503, '商品库尚未配置');
    const tokens = normalize(keyword).trim().split(/\s+/);
    const words = [...new Set(tokens)];
    if (words.length > 1) return searchWords(words, number);

    const single = tokens.length > 1 ? tokens[0] : keyword;
    const byUpc = /^\d{6,18}$/.test(single);
    const rows = await readPage(number - 1, pageSize, byUpc ? { upc: single } : { searchIndex: single });
    return { products: rows.slice(0, pageSize).filter(isProduct).map(product), page: number, hasMore: rows.length === pageSize };
  };
}
