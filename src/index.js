import { createApp } from './server.js';

const host = process.env.HOST || '127.0.0.1';
const port = Number(process.env.PORT || 3100);
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error('PORT 必须是 1 到 65535 的整数');
}

const server = createApp();
server.on('error', (error) => {
  console.error(`服务启动失败：${error.message}`);
  process.exitCode = 1;
});
server.listen(port, host, () => {
  console.log(`账号系统开发服务：http://${host}:${port}`);
});
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => server.close());
}
