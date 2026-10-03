'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { makeClock, makeWatcher, engineError, drain, START } = require('./helpers');

test('the reader advances its cursor and delivers a bounded batch per poll', () => {
  const clock = makeClock();
  const { watcher, sourceId } = makeWatcher({ name: 'cursor', clock });

  for (let i = 0; i < 250; i += 1) {
    watcher.sources.get(sourceId).source.append(engineError({ eventId: `E${i}`, userTaskId: `U${i}` }));
  }

  const first = watcher.poll(sourceId);
  assert.equal(first.polled, 100);
  assert.equal(first.cursor, 100);

  const second = watcher.poll(sourceId);
  assert.equal(second.polled, 100);
  assert.equal(second.cursor, 200);

  const third = watcher.poll(sourceId);
  assert.equal(third.polled, 50);
  assert.equal(third.cursor, 250);

  const empty = watcher.poll(sourceId);
  assert.equal(empty.polled, 0);
  assert.equal(empty.cursor, 250);
});

test('a replay from the cursor start delivers nothing twice', () => {
  const clock = makeClock();
  const { watcher, sourceId } = makeWatcher({ name: 'replay', clock });

  for (let i = 0; i < 3; i += 1) {
    watcher.sources.get(sourceId).source.append(engineError({ eventId: `E${i}`, userTaskId: `U${i}` }));
  }
  drain(watcher, sourceId);

  const incident = watcher.incidents.list()[0];
  const before = incident.count;

  const reader = watcher.sources.get(sourceId).reader;
  reader.resetCursor();
  const replay = watcher.poll(sourceId);

  assert.equal(replay.polled, 0);
  assert.equal(replay.duplicates, 3);
  assert.equal(watcher.incidents.list()[0].count, before);
  assert.equal(watcher.incidents.list().length, 1);
});

test('a duplicate eventId in the source log is counted as a delivery duplicate', () => {
  const clock = makeClock();
  const { watcher, sourceId } = makeWatcher({ name: 'dup', clock });

  const source = watcher.sources.get(sourceId).source;
  source.append(engineError({ eventId: 'E1', userTaskId: 'U1' }));
  drain(watcher, sourceId);
  source.append(engineError({ eventId: 'E1', userTaskId: 'U1' }));
  const report = watcher.poll(sourceId);

  assert.equal(report.polled, 0);
  assert.equal(report.duplicates, 1);
  assert.equal(watcher.incidents.list()[0].count, 1);
});

test('a truncated source log keeps the dropped count visible and replays from the start', () => {
  const clock = makeClock();
  const { watcher, sourceId } = makeWatcher({ name: 'truncated', clock });

  const source = watcher.sources.get(sourceId).source;
  for (let i = 0; i < 5; i += 1) {
    source.append(engineError({ eventId: `E${i}`, userTaskId: `U${i}` }));
  }
  drain(watcher, sourceId);
  assert.equal(watcher.sources.get(sourceId).reader.cursor(), 5);

  source.truncate();
  let report = watcher.poll(sourceId);
  assert.equal(report.dropped, 5);
  assert.equal(report.truncated, true);
  assert.equal(report.polled, 0);
  assert.equal(report.cursor, 0);

  for (let i = 0; i < 2; i += 1) {
    source.append(engineError({ eventId: `N${i}`, userTaskId: `N-U${i}` }));
  }
  report = watcher.poll(sourceId);
  assert.equal(report.dropped, 0);
  assert.equal(report.polled, 2);

  const entries = watcher.log.entries();
  const truncated = entries.find(entry => entry.event === 'reader.source_truncated');
  assert.ok(truncated);
  assert.equal(truncated.droppedCount, 5);
  assert.equal(truncated.reasonCode, 'SOURCE_LOG_TRUNCATED');
});

test('a source registration must declare schemas, retention, access policy and freshness', () => {
  const clock = makeClock();
  const { watcher, sourceId } = makeWatcher({ name: 'registry', clock });

  const spec = watcher.registry.get(sourceId);
  assert.equal(spec.service, 'telegram-gateway');
  assert.equal(spec.retentionClass, 'error_event_30d');
  assert.equal(spec.schemas.error, 'C12');
  assert.equal(spec.health.freshnessMs, 60000);

  const base = {
    service: 'telegram-gateway',
    owner: 'sandbox',
    transport: 'jsonl',
    retentionClass: 'error_event_30d',
    accessPolicy: { reader: 'error-watcher', scopes: ['error:read'] },
    freshnessMs: 60000,
    schemas: { error: 'C12', lifecycle: 'C12' },
    scopeRules: ['profile'],
  };
  assert.throws(() => watcher.registry.register({ ...base, sourceId: 'tg-gateway-errors' }), /already registered/);
  assert.throws(() => watcher.registry.register({ ...base, sourceId: 'no-freshness', freshnessMs: 0 }), /freshness/);
  assert.throws(() => watcher.registry.register({ ...base, sourceId: 'no-access', accessPolicy: undefined }), /access policy/);
  assert.throws(() => watcher.registry.register({ ...base, sourceId: 'no-retention', retentionClass: 'forever' }), /retention class/);
  assert.throws(() => watcher.registry.register({ ...base, sourceId: 'no-transport', transport: 'ftp' }), /transport/);
});