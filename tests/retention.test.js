'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { makeClock, makeWatcher, engineError, drain, START, DAY_MS } = require('./helpers');

test('retention archives only resolved incidents older than the TTL and keeps actives', () => {
  const clock = makeClock();
  const { watcher, sourceId } = makeWatcher({ name: 'retention', clock });

  for (let i = 0; i < 3; i += 1) {
    watcher.sources.get(sourceId).source.append(engineError({ eventId: `E${i}`, userTaskId: `U${i}` }));
  }
  drain(watcher, sourceId);
  const incident = watcher.incidents.list()[0];
  assert.equal(incident.state, 'open');

  watcher.resolveIncident(incident.incidentId, { actor: 'sandbox', reason: 'repair applied' });
  clock.advance(91 * DAY_MS);

  let cleanup = watcher.cleanup();
  assert.equal(cleanup.incidents.archived, 1);
  assert.equal(watcher.incidents.list()[0].archived, true);
  assert.deepEqual(watcher.incidents.list()[0].affectedProfileRefs, []);
  assert.equal(watcher.incidents.list()[0].count, 3);

  for (let i = 3; i < 6; i += 1) {
    watcher.sources.get(sourceId).source.append(engineError({ eventId: `E${i}`, userTaskId: `U${i}` }));
  }
  drain(watcher, sourceId);
  const active = watcher.incidents.list().find(item => item.state === 'open');
  assert.ok(active);

  clock.advance(91 * DAY_MS);
  cleanup = watcher.cleanup();
  assert.equal(cleanup.incidents.archived, 0);
  assert.equal(watcher.incidents.list().filter(item => item.archived).length, 1);
  assert.equal(watcher.sources.get(sourceId).reader.cursor(), 6);
});

test('an expired suppression rule is archived by the clock and stops matching', () => {
  const clock = makeClock();
  const { watcher, sourceId } = makeWatcher({ name: 'retention-mute', clock });

  watcher.sources.get(sourceId).source.append(engineError({ eventId: 'E0', userTaskId: 'U0' }));
  drain(watcher, sourceId);
  const fingerprint = watcher.incidents.list()[0].fingerprint;

  watcher.mute({
    fingerprint,
    scope: { kind: 'profile', tenantId: 'T1', profileId: 'P1', sourceId: 'telegram-gateway' },
    reason: 'waiting for the provider fix',
    actor: 'watcher-agent',
    expiresAt: new Date(START + DAY_MS).toISOString(),
  });

  watcher.sources.get(sourceId).source.append(engineError({ eventId: 'E1', userTaskId: 'U1' }));
  let decisions = drain(watcher, sourceId).flatMap(report => report.decisions);
  assert.equal(decisions[0].decision, 'suppressed');

  clock.advance(2 * DAY_MS);
  const cleanup = watcher.cleanup();
  assert.equal(cleanup.suppression.expired >= 1, true);

  watcher.sources.get(sourceId).source.append(engineError({ eventId: 'E2', userTaskId: 'U2' }));
  decisions = drain(watcher, sourceId).flatMap(report => report.decisions);
  assert.equal(decisions[0].decision, 'aggregated');
  assert.equal(watcher.suppression.list().filter(rule => !rule.expiredAt && !rule.revokedAt).length, 0);
});

test('a resolved reconciliation item is archived after its TTL but stays traceable', () => {
  const clock = makeClock();
  const { watcher, sourceId } = makeWatcher({ name: 'retention-recon', clock });

  const raw = engineError({ eventId: 'E0', userTaskId: 'U0' });
  delete raw.scope.profileId;
  watcher.sources.get(sourceId).source.append(raw);
  const decisions = drain(watcher, sourceId).flatMap(report => report.decisions);
  watcher.reconciliation.resolve(decisions[0].reconciliationId, { actor: 'ops', reason: 'profile recovered' });

  clock.advance(31 * DAY_MS);
  const cleanup = watcher.cleanup();
  assert.equal(cleanup.reconciliation.expired, 1);
  const item = watcher.reconciliation.get(decisions[0].reconciliationId);
  assert.equal(item.archived, true);
  assert.equal(item.event, null);
  assert.ok(watcher.reconciliation.entries().some(entry => entry.reasonCode === 'RECONCILIATION_RESOLVED'));
});

test('the self error bucket is bounded', () => {
  const clock = makeClock();
  const { watcher, sourceId } = makeWatcher({ name: 'retention-self', clock });

  for (let i = 0; i < 120; i += 1) {
    watcher.sources.get(sourceId).source.append(engineError({
      eventId: `S${i}`,
      userTaskId: `U${i}`,
      origin: { kind: 'watcher_diagnosis', incidentId: null, diagnosticDepth: 0 },
    }));
  }
  drain(watcher, sourceId);
  assert.equal(watcher.selfErrors.count(), 100);
  assert.equal(watcher.incidents.list().length, 0);
});