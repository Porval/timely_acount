import { createServer } from 'node:http';

export function createApp() {
  return createServer((request, response) => {
    const url = new URL(request.url, 'http://localhost');
    response.setHeader('Content-Type', 'application/json; charset=utf-8');
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    if (request.method === 'GET' && url.pathname === '/api/health') {
      response.writeHead(200);
      response.end(JSON.stringify({ status: 'ok', service: 'extras-account' }));
      return;
    }
    response.writeHead(404);
    response.end(JSON.stringify({ error: '接口不存在' }));
  });
}
