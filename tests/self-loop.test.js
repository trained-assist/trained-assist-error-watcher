'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { makeClock, makeWatcher, engineError, drain } = require('./helpers');

test('an error of the watcher itself creates no incident and no diagnosis', () => {
  const clock = makeClock();
  const { watcher, calls, sourceId } = makeWatcher({ name: 'self-loop', clock });

  watcher.sources.get(sourceId).source.append(engineError({
    eventId: 'S1',
    userTaskId: 'U1',
    origin: { kind: 'watcher_diagnosis', incidentId: 'INC_1', diagnosticDepth: 0 },
  }));
  const decisions = drain(watcher, sourceId).flatMap(report => report.decisions);

  assert.equal(decisions.length, 1);
  assert.equal(decisions[0].decision, 'self_error');
  assert.equal(decisions[0].incidentId, null);
  assert.equal(decisions[0].dispatchId, null);
  assert.equal(calls.length, 0);
  assert.equal(watcher.incidents.list().length, 0);
  assert.equal(watcher.selfErrors.count(), 1);
  assert.ok(watcher.log.entries().some(entry => entry.event === 'diagnosis.self_error'));
});

test('a diagnostic task that exceeds the depth limit is stopped, not recursed', () => {
  const clock = makeClock();
  const { watcher, calls, sourceId } = makeWatcher({ name: 'self-depth', clock, config: { maxDiagnosticDepth: 1 } });

  watcher.sources.get(sourceId).source.append(engineError({
    eventId: 'S1',
    userTaskId: 'U1',
    origin: { kind: 'watcher_diagnosis', incidentId: 'INC_1', diagnosticDepth: 2 },
  }));
  const decisions = drain(watcher, sourceId).flatMap(report => report.decisions);

  assert.equal(decisions[0].decision, 'self_error');
  assert.equal(decisions[0].reasonCode, 'WATCHER_SELF_ERROR');
  assert.equal(decisions[0].diagnosticDepth, 2);
  assert.equal(calls.length, 0);
  assert.equal(watcher.incidents.list().length, 0);
});

test('a self error does not reopen a muted incident', () => {
  const clock = makeClock();
  const { watcher, sourceId } = makeWatcher({ name: 'self-muted', clock });

  watcher.sources.get(sourceId).source.append(engineError({ eventId: 'E0', userTaskId: 'U0' }));
  drain(watcher, sourceId);
  const incident = watcher.incidents.list()[0];
  watcher.mute({
    fingerprint: incident.fingerprint,
    scope: { kind: 'profile', tenantId: 'T1', profileId: 'P1', sourceId: 'telegram-gateway' },
    reason: 'muted while the watcher fault is investigated',
    actor: 'watcher-agent',
    expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
  });

  watcher.sources.get(sourceId).source.append(engineError({
    eventId: 'S1',
    userTaskId: 'U1',
    origin: { kind: 'watcher_delivery', incidentId: incident.incidentId, diagnosticDepth: 0 },
  }));
  const decisions = drain(watcher, sourceId).flatMap(report => report.decisions);

  assert.equal(decisions[0].decision, 'self_error');
  assert.equal(watcher.incidents.list()[0].count, 1);
  assert.equal(watcher.incidents.list()[0].suppressedCount, 0);
});