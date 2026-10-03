'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');

const { makeClock, makeWatcher, engineError, drain, START } = require('./helpers');
const { createIntakeServer } = require('../src/http/intake-server');
const { hashKey } = require('../src/sources/push-intake');

function post(port, { apiKey, scopes, event }) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(event);
    const req = http.request({
      host: '127.0.0.1',
      port,
      path: '/errors',
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(body),
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
    req.end(body);
  });
}

test('an external installation connects with a key and a scope over loopback', async () => {
  const clock = makeClock();
  const apiKey = 'sandbox-watcher-key';
  const readOnlyKey = 'sandbox-readonly-key';
  const keyStore = new Map([[hashKey(apiKey), ['error:write']], [hashKey(readOnlyKey), ['error:read']]]);
  const { watcher } = makeWatcher({ name: 'push', clock, registerDefault: false });
  const spec = {
    sourceId: 'external-installation-errors',
    service: 'external-installation',
    owner: 'sandbox',
    transport: 'http_push',
    retentionClass: 'error_event_30d',
    accessPolicy: { reader: 'error-watcher', scopes: ['error:read'] },
    freshnessMs: 60000,
    schemas: { error: 'C12', lifecycle: 'C12' },
    scopeRules: ['profile'],
  };
  const entry = watcher.attachPushSource(spec, { keyStore });
  const sourceId = entry.spec.sourceId;
  const server = createIntakeServer({ intake: entry.intake });
  const { port } = await server.start();
  try {

  const event = engineError({ eventId: 'E1', userTaskId: 'U1' });
  event.source = { service: 'external-installation', release: 'sandbox', environment: 'sandbox' };

  const accepted = await post(port, { apiKey, scopes: ['error:write'], event });
  assert.equal(accepted.status, 202);
  assert.equal(accepted.payload.reasonCode, 'EVENT_ACCEPTED');
  assert.equal(accepted.payload.receipt.eventId, 'E1');

  const duplicate = await post(port, { apiKey, scopes: ['error:write'], event });
  assert.equal(duplicate.status, 202);
  assert.equal(duplicate.payload.duplicate, true);
  assert.equal(duplicate.payload.reasonCode, 'DUPLICATE_EVENT_IGNORED');

  const wrongKey = await post(port, { apiKey: 'other-key', scopes: ['error:write'], event: engineError({ eventId: 'E2', userTaskId: 'U2' }) });
  assert.equal(wrongKey.status, 401);
  assert.equal(wrongKey.payload.reasonCode, 'INTAKE_KEY_UNKNOWN');

  const noScope = await post(port, { apiKey: readOnlyKey, scopes: ['error:read'], event: engineError({ eventId: 'E3', userTaskId: 'U3' }) });
  assert.equal(noScope.status, 403);
  assert.equal(noScope.payload.reasonCode, 'INTAKE_SCOPE_MISSING');

  } finally {
    await server.stop();
  }

  assert.equal(watcher.sources.get(sourceId).source.size(), 1);
  const decisions = drain(watcher, sourceId).flatMap(report => report.decisions);
  assert.equal(decisions.length, 1);
  assert.equal(decisions[0].decision, 'opened');
  assert.equal(watcher.incidents.list().length, 1);
});

test('the intake server refuses unknown routes', async () => {
  const clock = makeClock();
  const apiKey = 'sandbox-watcher-key';
  const readOnlyKey = 'sandbox-readonly-key';
  const keyStore = new Map([[hashKey(apiKey), ['error:write']], [hashKey(readOnlyKey), ['error:read']]]);
  const { watcher } = makeWatcher({ name: 'push-route', clock, registerDefault: false });
  const entry = watcher.attachPushSource({
    sourceId: 'external-installation-errors',
    service: 'external-installation',
    owner: 'sandbox',
    transport: 'http_push',
    retentionClass: 'error_event_30d',
    accessPolicy: { reader: 'error-watcher', scopes: ['error:read'] },
    freshnessMs: 60000,
    schemas: { error: 'C12', lifecycle: 'C12' },
    scopeRules: ['profile'],
  }, { keyStore });
  const server = createIntakeServer({ intake: entry.intake });
  const { port } = await server.start();
  try {

  const res = await new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: '/nope', method: 'POST', headers: { 'content-length': 0 } }, response => {
      response.on('data', () => undefined);
      response.on('end', () => resolve(response.statusCode));
    });
    req.on('error', reject);
    req.end();
  });
  assert.equal(res, 404);
  } finally {
    await server.stop();
  }
});