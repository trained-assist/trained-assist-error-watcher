'use strict';

// Общие песочницы для тестов: виртуальные часы, изолированный корень, фабрика
// watcher'а и генератор событий движка. Прод и VM не используются.

const fs = require('fs');
const path = require('path');
const { createErrorWatcher } = require('../src/watcher/index.js');

const START = Date.parse('2026-10-03T09:00:00.000Z');
const DAY_MS = 24 * 60 * 60 * 1000;

function makeClock(start = START) {
  let tick = 0;
  return {
    now: () => new Date(start + tick),
    advance: ms => {
      tick += ms;
    },
    get tick() {
      return tick;
    },
  };
}

function makeRoot(name) {
  const root = path.join(__dirname, '.sandbox', `${name}-${process.pid}`);
  fs.rmSync(root, { recursive: true, force: true });
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  return root;
}

const DEFAULT_SOURCE_SPEC = {
  sourceId: 'tg-gateway-errors',
  service: 'telegram-gateway',
  owner: 'sandbox',
  transport: 'jsonl',
  retentionClass: 'error_event_30d',
  accessPolicy: { reader: 'error-watcher', scopes: ['error:read'] },
  freshnessMs: 60 * 1000,
  schemas: { error: 'C12', lifecycle: 'C12' },
  scopeRules: ['profile'],
};

function makeWatcher({ name = 'watcher', clock, config = {}, sourceSpec = DEFAULT_SOURCE_SPEC, dispatcher, registerDefault = true } = {}) {
  const root = makeRoot(name);
  const calls = [];
  const watcher = createErrorWatcher({
    root,
    now: clock ? clock.now : undefined,
    config,
    dispatcher: dispatcher || (intent => {
      calls.push(intent.dispatchId);
      return { status: 'submitted', detail: 'fake sink' };
    }),
  });
  if (registerDefault) watcher.registerSource(sourceSpec);
  return { watcher, root, calls, sourceId: sourceSpec.sourceId };
}

function engineError({ eventId, userTaskId, runId, profileId = 'P1', tenantId = 'T1', severity = 'error', code = 'ENGINE_ZERO_COST', occurredAt, stack, origin } = {}) {
  return {
    schemaVersion: 1,
    eventId,
    occurredAt: occurredAt || new Date(START).toISOString(),
    source: { service: 'telegram-gateway', release: 'sandbox', environment: 'sandbox' },
    scope: { kind: 'profile', tenantId, profileId },
    correlation: { userTaskId: userTaskId || null, runId: runId || null, traceId: `TR-${eventId}` },
    replyContext: { channel: 'telegram', destinationRef: 'D1', status: 'known' },
    error: {
      code,
      operation: 'runAgent',
      severity,
      retryable: false,
      outcome: 'failed',
      safeSummary: 'Движок вернул ошибку с нулевым расходом',
      privateDetailsRef: `artifact:LOG-${eventId}`,
      stack: stack || `Error: engine failed\n    at runAgent (/srv/runner/index.js:12:34)\n    at process (/srv/runner/worker.js:567:9)`,
    },
    origin: origin || { kind: 'application', incidentId: null, diagnosticDepth: 0 },
  };
}

function platformError({ eventId, code = 'HOST_OUTAGE', occurredAt } = {}) {
  return {
    schemaVersion: 1,
    eventId,
    occurredAt: occurredAt || new Date(START).toISOString(),
    source: { service: 'runner-host', release: 'sandbox', environment: 'sandbox' },
    scope: { kind: 'platform' },
    correlation: { operationId: `OP-${eventId}` },
    replyContext: { channel: null, destinationRef: null, status: 'not_applicable' },
    error: {
      code,
      operation: 'hostHeartbeat',
      severity: 'error',
      retryable: true,
      outcome: 'unknown',
      safeSummary: 'Хост перестал отвечать на heartbeat',
      privateDetailsRef: `artifact:HOST-${eventId}`,
    },
    origin: { kind: 'application', incidentId: null, diagnosticDepth: 0 },
  };
}

function drain(watcher, sourceId) {
  const reports = [];
  for (let guard = 0; guard < 10000; guard += 1) {
    const report = watcher.poll(sourceId);
    reports.push(report);
    if (report.polled === 0) break;
  }
  return reports;
}

module.exports = {
  START,
  DAY_MS,
  makeClock,
  makeRoot,
  makeWatcher,
  DEFAULT_SOURCE_SPEC,
  engineError,
  platformError,
  drain,
};
