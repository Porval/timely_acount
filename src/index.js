import { createApp } from './server.js';
import { loadConfig } from './config.js';

const config = loadConfig();
const server = createApp({ config });
server.on('error', (error) => {
  console.error(`服务启动失败：${error.message}`);
  process.exitCode = 1;
});
server.listen(config.port, config.host, () => {
  console.log(`账户后台：http://${config.host}:${config.port}`);
  if (config.smsMode === 'console') console.log('当前为本地开发验证码模式，未发送真实短信。');
});
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => server.close());
