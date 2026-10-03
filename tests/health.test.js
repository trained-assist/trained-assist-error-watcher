'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { makeClock, makeWatcher, engineError, drain, START } = require('./helpers');
const { fingerprintFor } = require('../src/contract/fingerprint');
const { normalizeErrorEvent } = require('../src/contract/error-event');

test('a healthy watcher reports ok with a deterministic alarm id', () => {
  const clock = makeClock();
  const { watcher, sourceId } = makeWatcher({ name: 'health-ok', clock });

  watcher.sources.get(sourceId).source.append(engineError({ eventId: 'E0', userTaskId: 'U0' }));
  drain(watcher, sourceId);

  const first = watcher.health.evaluate();
  const second = watcher.health.evaluate();
  assert.equal(first.status, 'ok');
  assert.deepEqual(first.reasons, []);
  assert.equal(first.alarmId, second.alarmId);
  assert.match(first.alarmId, /^ALM_[0-9a-f]{24}$/);
});

test('a backlog behind the cursor raises a failing alarm', () => {
  const clock = makeClock();
  const { watcher, sourceId } = makeWatcher({ name: 'health-backlog', clock, config: { maxBacklog: 10 } });

  for (let i = 0; i < 25; i += 1) {
    watcher.sources.get(sourceId).source.append(engineError({ eventId: `E${i}`, userTaskId: `U${i}` }));
  }

  const report = watcher.health.evaluate();
  assert.equal(report.status, 'failing');
  assert.ok(report.reasons.some(reason => reason.code === 'SOURCE_BACKLOG' && reason.sourceId === sourceId));
});

test('a source that stops being polled raises a stale alarm', () => {
  const clock = makeClock();
  const { watcher, sourceId } = makeWatcher({ name: 'health-stale', clock, config: { maxBacklog: 100000 } });

  watcher.sources.get(sourceId).source.append(engineError({ eventId: 'E0', userTaskId: 'U0' }));
  drain(watcher, sourceId);
  assert.equal(watcher.health.evaluate().status, 'ok');

  clock.advance(5 * 60 * 1000);
  const report = watcher.health.evaluate();
  assert.equal(report.status, 'failing');
  assert.ok(report.reasons.some(reason => reason.code === 'SOURCE_STALE'));
});

test('suppression never silences the health alarm', () => {
  const clock = makeClock();
  const { watcher, sourceId } = makeWatcher({ name: 'health-mute', clock, config: { maxBacklog: 10 } });

  for (let i = 0; i < 30; i += 1) {
    watcher.sources.get(sourceId).source.append(engineError({ eventId: `E${i}`, userTaskId: `U${i}` }));
  }
  watcher.mute({
    fingerprint: fingerprintFor(normalizeErrorEvent(engineError({ eventId: 'X' })).event),
    scope: { kind: 'profile', tenantId: 'T1', profileId: 'P1', sourceId: 'telegram-gateway' },
    reason: 'muted for the test',
    actor: 'watcher-agent',
    expiresAt: new Date(START + 24 * 60 * 60 * 1000).toISOString(),
  });

  const report = watcher.health.evaluate();
  assert.equal(report.status, 'failing');
  assert.ok(report.reasons.some(reason => reason.code === 'SOURCE_BACKLOG'));
  assert.ok(watcher.log.entries().some(entry => entry.event === 'watcher.health_alarm'));
});

test('watcher self errors are visible to the alarm', () => {
  const clock = makeClock();
  const { watcher, sourceId } = makeWatcher({ name: 'health-self', clock, config: { maxSelfErrors: 2 } });

  for (let i = 0; i < 4; i += 1) {
    watcher.sources.get(sourceId).source.append(engineError({
      eventId: `S${i}`,
      userTaskId: `U${i}`,
      origin: { kind: 'watcher_delivery', incidentId: null, diagnosticDepth: 0 },
    }));
  }
  drain(watcher, sourceId);

  const report = watcher.health.evaluate();
  assert.equal(report.status, 'failing');
  assert.ok(report.reasons.some(reason => reason.code === 'SELF_ERRORS'));
});