import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/server.js';

test('服务启动并提供健康检查；未知接口返回 404', async (t) => {
  const server = createApp();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => {
    server.close(resolve);
    server.closeAllConnections();
  }));
  const base = `http://127.0.0.1:${server.address().port}`;
  const health = await fetch(`${base}/api/health`);
  assert.equal(health.status, 200);
  assert.deepEqual(await health.json(), { status: 'ok', service: 'extras-account' });
  const missing = await fetch(`${base}/api/missing`);
  assert.equal(missing.status, 404);
});
