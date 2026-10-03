'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { makeClock, makeWatcher, engineError, platformError, drain, START } = require('./helpers');

test('a profile error without a profile goes to reconciliation, never to a user', () => {
  const clock = makeClock();
  const { watcher, calls, sourceId } = makeWatcher({ name: 'unknown-profile', clock });

  const raw = engineError({ eventId: 'E1', userTaskId: 'U1' });
  delete raw.scope.profileId;
  watcher.sources.get(sourceId).source.append(raw);
  const decisions = drain(watcher, sourceId).flatMap(report => report.decisions);

  assert.equal(decisions.length, 1);
  assert.equal(decisions[0].decision, 'quarantined');
  assert.equal(decisions[0].delivery, 'none');
  assert.equal(decisions[0].incidentId, null);
  assert.equal(decisions[0].dispatchId, null);
  assert.equal(calls.length, 0);
  assert.equal(watcher.incidents.list().length, 0);

  const open = watcher.reconciliation.list().filter(item => item.status === 'open');
  assert.equal(open.length, 1);
  assert.ok(open[0].violations.includes('PROFILE_REQUIRED'));
  assert.equal(open[0].event.eventId, 'E1');
  assert.equal(watcher.sources.get(sourceId).source.size(), 1);

  const log = watcher.log.entries();
  assert.ok(log.some(entry => entry.event === 'reconciliation.quarantined' && entry.reasonCode === 'CONTRACT_VIOLATION'));
  assert.ok(!log.some(entry => entry.to === 'delivered'));
});

test('an event from an unregistered service is quarantined instead of being parsed', () => {
  const clock = makeClock();
  const { watcher, sourceId } = makeWatcher({ name: 'unregistered', clock });

  const raw = engineError({ eventId: 'E1', userTaskId: 'U1' });
  raw.source.service = 'some-other-service';
  watcher.sources.get(sourceId).source.append(raw);
  const decisions = drain(watcher, sourceId).flatMap(report => report.decisions);

  assert.equal(decisions[0].decision, 'quarantined');
  assert.equal(decisions[0].reasonCode, 'SOURCE_NOT_REGISTERED');
  assert.equal(watcher.incidents.list().length, 0);
});

test('a platform outage aggregates without a profile and without user delivery', () => {
  const clock = makeClock();
  const { watcher, calls, sourceId } = makeWatcher({
    name: 'platform',
    clock,
    sourceSpec: {
      sourceId: 'runner-host-errors',
      service: 'runner-host',
      owner: 'sandbox',
      transport: 'jsonl',
      retentionClass: 'error_event_30d',
      accessPolicy: { reader: 'error-watcher', scopes: ['error:read'] },
      freshnessMs: 60000,
      schemas: { error: 'C12', lifecycle: 'C12' },
      scopeRules: ['platform'],
    },
  });

  for (let i = 0; i < 4; i += 1) {
    watcher.sources.get(sourceId).source.append(platformError({ eventId: `H${i}` }));
  }
  const decisions = drain(watcher, sourceId).flatMap(report => report.decisions);

  assert.equal(decisions.length, 4);
  assert.equal(new Set(decisions.map(decision => decision.incidentId)).size, 1);
  assert.equal(calls.length, 1);
  assert.ok(decisions.every(decision => decision.delivery === 'none'));

  const incident = watcher.incidents.list()[0];
  assert.equal(incident.scope.kind, 'platform');
  assert.equal(incident.affectedProfileRefs.length, 0);
  assert.equal(incident.count, 4);
});

test('a web-only reply context is aggregated but not delivered to a chat', () => {
  const clock = makeClock();
  const { watcher, sourceId } = makeWatcher({ name: 'web-only', clock });

  const raw = engineError({ eventId: 'E1', userTaskId: 'U1' });
  raw.replyContext = { channel: null, destinationRef: null, status: 'web_only' };
  watcher.sources.get(sourceId).source.append(raw);
  const decisions = drain(watcher, sourceId).flatMap(report => report.decisions);

  assert.equal(decisions[0].decision, 'opened');
  assert.equal(decisions[0].delivery, 'web_only');
  assert.equal(watcher.incidents.list().length, 1);
});

test('a quarantined event can be resolved by ops and stays traceable', () => {
  const clock = makeClock();
  const { watcher, sourceId } = makeWatcher({ name: 'reconcile-resolve', clock });

  const raw = engineError({ eventId: 'E1', userTaskId: 'U1' });
  delete raw.scope.profileId;
  watcher.sources.get(sourceId).source.append(raw);
  const decisions = drain(watcher, sourceId).flatMap(report => report.decisions);

  const item = watcher.reconciliation.get(decisions[0].reconciliationId);
  watcher.reconciliation.resolve(item.reconciliationId, { actor: 'ops-oncall', reason: 'profile recovered from the task envelope' });

  const resolved = watcher.reconciliation.get(item.reconciliationId);
  assert.equal(resolved.status, 'resolved');
  assert.equal(resolved.resolvedBy, 'ops-oncall');
  assert.equal(watcher.reconciliation.openCount(), 0);
  assert.ok(watcher.reconciliation.entries().some(entry => entry.reasonCode === 'RECONCILIATION_RESOLVED'));
});