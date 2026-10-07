'use strict';

// Минимальный loopback HTTP-транспорт для http_push источников. Только
// 127.0.0.1, один endpoint, ключ в заголовке. Это транспорт песочницы, не
// production ingress: внешний доступ объявляется отдельно.

const http = require('http');

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

/**
 * @param {object} options
 * @param {object} options.intake createPushIntake
 * @param {number} [options.port]
 */
function createIntakeServer({ intake, port = 0 } = {}) {
  if (!intake) throw new Error('intake server requires a push intake');

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    if (req.method === 'GET' && url.pathname === '/healthz') {
      const report = health();
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(report));
      return;
    }
    if (req.method !== 'POST' || url.pathname !== '/errors') {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ reasonCode: 'INTAKE_ROUTE_UNKNOWN' }));
      return;
    }
    Promise.resolve()
      .then(() => readBody(req))
      .then(body => {
        let event = null;
        try {
          event = JSON.parse(body || 'null');
        } catch {
          event = null;
        }
        const result = intake.receive({
          apiKey: req.headers['x-watcher-key'] || null,
          scopes: (req.headers['x-watcher-scopes'] || '').split(',').map(part => part.trim()).filter(Boolean),
          event,
        });
        res.writeHead(result.status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(result));
      })
      .catch(() => {
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ reasonCode: 'INTAKE_INTERNAL_ERROR' }));
      });
  });

  function start() {
    return new Promise(resolve => {
      server.listen(port, '127.0.0.1', () => resolve({ port: server.address().port }));
    });
  }

  function stop() {
    return new Promise(resolve => server.close(() => resolve()));
  }

  function health() {
    return intake.health?.() ?? { status: 'ok', reasonCodes: [], alarmId: null };
  }

  return { start, stop, server };
}

module.exports = { createIntakeServer };
