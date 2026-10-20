import { createHash } from 'node:crypto';
import { AppError } from './service.js';
export const MAX_SCREENSHOT_BYTES = 5 * 1024 * 1024;
export function parseScreenshot(value) {
  if (!value || typeof value.data !== 'string' || !value.data) throw new AppError(400, '请上传付款截图');
  if (value.data.length > Math.ceil(MAX_SCREENSHOT_BYTES / 3) * 4) throw new AppError(413, '付款截图不能超过 5 MB');
  if (value.data.length % 4 !== 0) throw new AppError(400, '付款截图数据不正确');
  const data = Buffer.from(value.data, 'base64');
  if (data.toString('base64') !== value.data) throw new AppError(400, '付款截图数据不正确');
  if (!data.length || data.length > MAX_SCREENSHOT_BYTES) throw new AppError(413, '付款截图不能超过 5 MB');
  const matches = {
    'image/png': data.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])),
    'image/jpeg': data[0] === 255 && data[1] === 216 && data[2] === 255,
    'image/webp': data.subarray(0,4).toString() === 'RIFF' && data.subarray(8,12).toString() === 'WEBP',
  };
  if (!['image/png','image/jpeg','image/webp'].includes(value.contentType) || !matches[value.contentType]) throw new AppError(400, '付款截图仅支持有效的 JPG、PNG 或 WebP 图片');
  return { data, contentType: value.contentType, size: data.length, sha256: createHash('sha256').update(data).digest('hex') };
}
export function sendScreenshot(response, screenshot) {
  response.writeHead(200, {'Content-Type':screenshot.content_type,'Content-Length':screenshot.data.length,'Content-Disposition':'inline','Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff'});
  response.end(screenshot.data);
}
