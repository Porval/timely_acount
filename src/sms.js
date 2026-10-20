import { AppError } from './service.js';

// Matches warehouse_account/src/util.ts. The server controls the template.
export const DEFAULT_SMS_TEMPLATE = '【上海蜜田科技】注册绑定手机号验证码是${code}';

function endpoint(config, path) {
  const base = new URL(config.smsHost);
  base.pathname = `${base.pathname.replace(/\/+$/, '')}/${path.replace(/^\/+/, '')}`;
  base.search = '';
  base.hash = '';
  return base;
}
async function postSms(config, path, input, fetchImpl) {
  let response;
  try {
    response = await fetchImpl(endpoint(config, path), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json',
        ...(config.smsToken ? { Authorization: `Bearer ${config.smsToken}` } : {}) },
      body: JSON.stringify(input), redirect: 'error', signal: AbortSignal.timeout(10000),
    });
  } catch { throw new AppError(502, '短信接口暂不可用，请稍后重试'); }
  let result;
  try {
    const raw = await response.text();
    if (raw.length > 65536) throw new Error('response too large');
    result = JSON.parse(raw);
    if (!result || typeof result !== 'object' || Array.isArray(result)) throw new Error('invalid response');
  } catch { throw new AppError(502, '短信接口响应格式不正确'); }
  if (!response.ok) {
    if (response.status === 429) throw new AppError(429, '验证码操作过于频繁，请稍后重试');
    if (path.endsWith('verifyCode') && [400, 401, 403, 422].includes(response.status)) throw new AppError(401, '验证码无效或已过期，请重新获取');
    throw new AppError(502, '短信接口暂不可用，请稍后重试');
  }
  return result;
}
export function createSmsSender(config, fetchImpl = fetch) {
  return async ({ mobile, code }) => {
    if (config.smsMode === 'console') {
      console.log(`[开发验证码，未发送短信] ${mobile}: ${code}（5 分钟有效）`);
      return;
    }
    const result = await postSms(config, 'api/sms/requestCode', {
      number: mobile, template: config.smsTemplate || DEFAULT_SMS_TEMPLATE,
    }, fetchImpl);
    if (result.success === false || result.error === true) throw new AppError(502, '短信发送失败，请稍后重试');
  };
}
export function createSmsVerifier(config, fetchImpl = fetch) {
  if (config.smsMode === 'console') return undefined;
  return async ({ mobile, code }) => {
    const result = await postSms(config, 'api/sms/verifyCode', {
      [config.smsPhoneField || 'phone']: mobile, [config.smsCodeField || 'code']: code,
    }, fetchImpl);
    // Fail closed: the actual BFF response must be confirmed before supporting other response shapes.
    return result.success === true && result.error !== true && result.verified !== false;
  };
}
