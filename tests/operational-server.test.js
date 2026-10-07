'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');

const { makeClock, makeWatcher, engineError, drain, START } = require('./helpers');
const { createOperationalServer } = require('../src/http/operational-server');
const { hashKey } = require('../src/sources/push-intake');

function get(port, path, { apiKey, scopes } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1',
      port,
      path,
      method: 'GET',
      headers: {
        ...(apiKey ? { 'x-watcher-key': apiKey } : {}),
        ...(scopes ? { 'x-watcher-scopes': scopes.join(',') } : {}),
      },
    }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => {
        let payload = null;
        try {
          payload = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        } catch {
          payload = null;
        }
        resolve({ status: res.statusCode, payload });
      });
    });
    req.on('error', reject);
    req.end();
  });
}

function makeKeyStore() {
  const readKey = 'sandbox-read-key';
  const writeKey = 'sandbox-write-key';
  const badKey = 'sandbox-bad-key';
  return {
    store: new Map([
      [hashKey(readKey), ['error:read']],
      [hashKey(writeKey), ['error:write']],
      [hashKey(badKey), ['error:write']],
    ]),
    readKey,
    writeKey,
    badKey,
  };
}

test('GET /health returns ok with deterministic alarmId', async () => {
  const clock = makeClock();
  const { watcher, sourceId } = makeWatcher({ name: 'ops-health', clock });
  watcher.sources.get(sourceId).source.append(engineError({ eventId: 'E0', userTaskId: 'U0' }));
  drain(watcher, sourceId);

  const { store, readKey } = makeKeyStore();
  const server = createOperationalServer({ watcher, keyStore: store });
  const { port } = await server.start();
  try {
    const first = await get(port, '/health', { apiKey: readKey, scopes: ['error:read'] });
    assert.equal(first.status, 200);
    assert.equal(first.payload.status, 'ok');
    assert.match(first.payload.alarmId, /^ALM_[0-9a-f]{24}$/);

    const second = await get(port, '/health', { apiKey: readKey, scopes: ['error:read'] });
    assert.equal(second.payload.alarmId, first.payload.alarmId);
  } finally {
    await server.stop();
  }
});

test('GET /health requires error:read scope', async () => {
  const clock = makeClock();
  const { watcher } = makeWatcher({ name: 'ops-auth', clock });

  const { store, writeKey } = makeKeyStore();
  const server = createOperationalServer({ watcher, keyStore: store });
  const { port } = await server.start();
  try {
    const noKey = await get(port, '/health');
    assert.equal(noKey.status, 401);
    assert.equal(noKey.payload.reasonCode, 'INTAKE_KEY_UNKNOWN');

    const wrongScope = await get(port, '/health', { apiKey: writeKey, scopes: ['error:write'] });
    assert.equal(wrongScope.status, 403);
    assert.equal(wrongScope.payload.reasonCode, 'INTAKE_SCOPE_MISSING');
  } finally {
    await server.stop();
  }
});

test('GET /incidents returns open incidents with filters', async () => {
  const clock = makeClock();
  const { watcher, sourceId } = makeWatcher({ name: 'ops-incidents', clock });

  for (let i = 0; i < 3; i += 1) {
    watcher.sources.get(sourceId).source.append(engineError({ eventId: `E${i}`, userTaskId: `U${i}` }));
  }
  drain(watcher, sourceId);

  const { store, readKey } = makeKeyStore();
  const server = createOperationalServer({ watcher, keyStore: store });
  const { port } = await server.start();
  try {
    const all = await get(port, '/incidents', { apiKey: readKey, scopes: ['error:read'] });
    assert.equal(all.status, 200);
    assert.equal(all.payload.total, 1);
    assert.equal(all.payload.incidents[0].service, 'telegram-gateway');
    assert.equal(all.payload.incidents[0].count, 3);

    const open = await get(port, '/incidents?status=open', { apiKey: readKey, scopes: ['error:read'] });
    assert.equal(open.payload.total, 1);

    const empty = await get(port, '/incidents?status=resolved', { apiKey: readKey, scopes: ['error:read'] });
    assert.equal(empty.payload.total, 0);
  } finally {
    await server.stop();
  }
});

test('GET /incidents/:id returns single incident detail', async () => {
  const clock = makeClock();
  const { watcher, sourceId } = makeWatcher({ name: 'ops-incident-detail', clock });

  watcher.sources.get(sourceId).source.append(engineError({ eventId: 'E1', userTaskId: 'U1' }));
  drain(watcher, sourceId);

  const incidentId = watcher.incidents.list()[0].incidentId;

  const { store, readKey } = makeKeyStore();
  const server = createOperationalServer({ watcher, keyStore: store });
  const { port } = await server.start();
  try {
    const found = await get(port, `/incidents/${incidentId}`, { apiKey: readKey, scopes: ['error:read'] });
    assert.equal(found.status, 200);
    assert.equal(found.payload.incidentId, incidentId);
    assert.equal(found.payload.service, 'telegram-gateway');
    assert.ok(found.payload.fingerprint);

    const missing = await get(port, '/incidents/INC_nonexistent', { apiKey: readKey, scopes: ['error:read'] });
    assert.equal(missing.status, 404);
    assert.equal(missing.payload.reasonCode, 'INCIDENT_NOT_FOUND');
  } finally {
    await server.stop();
  }
});

test('GET /sources/:id/health returns source freshness', async () => {
  const clock = makeClock();
  const { watcher, sourceId } = makeWatcher({ name: 'ops-source-health', clock });

  watcher.sources.get(sourceId).source.append(engineError({ eventId: 'E0', userTaskId: 'U0' }));
  drain(watcher, sourceId);

  const { store, readKey } = makeKeyStore();
  const server = createOperationalServer({ watcher, keyStore: store });
  const { port } = await server.start();
  try {
    const health = await get(port, `/sources/${sourceId}/health`, { apiKey: readKey, scopes: ['error:read'] });
    assert.equal(health.status, 200);
    assert.equal(health.payload.sourceId, sourceId);
    assert.equal(health.payload.service, 'telegram-gateway');
    assert.equal(health.payload.backlog, 0);

    const missing = await get(port, '/sources/nonexistent/health', { apiKey: readKey, scopes: ['error:read'] });
    assert.equal(missing.status, 404);
    assert.equal(missing.payload.reasonCode, 'SOURCE_NOT_FOUND');
  } finally {
    await server.stop();
  }
});

test('operational server refuses unknown routes and non-GET methods', async () => {
  const clock = makeClock();
  const { watcher } = makeWatcher({ name: 'ops-routes', clock });

  const { store, readKey } = makeKeyStore();
  const server = createOperationalServer({ watcher, keyStore: store });
  const { port } = await server.start();
  try {
    const unknown = await get(port, '/nope', { apiKey: readKey, scopes: ['error:read'] });
    assert.equal(unknown.status, 404);
    assert.equal(unknown.payload.reasonCode, 'ROUTE_UNKNOWN');
  } finally {
    await server.stop();
  }
});
