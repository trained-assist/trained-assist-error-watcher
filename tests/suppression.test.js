'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { makeClock, makeWatcher, engineError, drain, START, DAY_MS } = require('./helpers');
const { fingerprintFor } = require('../src/contract/fingerprint');
const { normalizeErrorEvent } = require('../src/contract/error-event');

const SCOPE = { kind: 'profile', tenantId: 'T1', sourceId: 'telegram-gateway' };

function fingerprint() {
  return fingerprintFor(normalizeErrorEvent(engineError({ eventId: 'E1' })).event);
}

function feed(watcher, sourceId, count, from) {
  for (let i = 0; i < count; i += 1) {
    watcher.sources.get(sourceId).source.append(engineError({
      eventId: `E${from + i}`,
      userTaskId: `U${from + i}`,
      occurredAt: new Date(START + (from + i) * 1000).toISOString(),
    }));
  }
  return drain(watcher, sourceId).flatMap(report => report.decisions);
}

test('a timed mute is recorded with a reason and an author and silences diagnosis', () => {
  const clock = makeClock();
  const { watcher, calls, sourceId } = makeWatcher({ name: 'mute', clock });

  feed(watcher, sourceId, 2, 0);
  assert.equal(calls.length, 1);

  const rule = watcher.mute({
    fingerprint: fingerprint(),
    scope: { ...SCOPE, profileId: 'P1' },
    reason: 'third-party outage, diagnosis already filed upstream',
    actor: 'watcher-agent',
    expiresAt: new Date(START + DAY_MS).toISOString(),
  });

  assert.equal(rule.kind, 'mute_until');
  assert.equal(rule.reason.length > 0, true);
  assert.equal(rule.actor, 'watcher-agent');
  assert.equal(rule.expiresAt, new Date(START + DAY_MS).toISOString());

  const decisions = feed(watcher, sourceId, 10, 2);
  assert.equal(decisions.length, 10);
  assert.ok(decisions.every(decision => decision.decision === 'suppressed'));
  assert.equal(calls.length, 1);

  const incident = watcher.incidents.list()[0];
  assert.equal(incident.count, 12);
  assert.equal(incident.suppressedCount, 10);
  assert.equal(incident.state, 'open');
  assert.equal(watcher.sources.get(sourceId).source.size(), 12);

  const audit = watcher.suppression.auditEntries();
  assert.ok(audit.some(entry => entry.reasonCode === 'SUPPRESSION_MUTE_CREATED' && entry.actor === 'watcher-agent'));
});

test('an expired mute stops matching and the next event reopens diagnosis', () => {
  const clock = makeClock();
  const { watcher, calls, sourceId } = makeWatcher({ name: 'mute-expiry', clock });

  feed(watcher, sourceId, 2, 0);
  const incidentId = watcher.incidents.list()[0].incidentId;
  watcher.closeDiagnosticSlot(incidentId, 'completed');
  watcher.resolveIncident(incidentId, { actor: 'sandbox', reason: 'repair applied' });

  watcher.mute({
    fingerprint: fingerprint(),
    scope: { ...SCOPE, profileId: 'P1' },
    reason: 'waiting for the provider to fix the outage',
    actor: 'watcher-agent',
    expiresAt: new Date(START + DAY_MS).toISOString(),
  });

  let decisions = feed(watcher, sourceId, 3, 2);
  assert.ok(decisions.every(decision => decision.decision === 'suppressed'));
  assert.equal(calls.length, 1);

  clock.advance(DAY_MS + 60 * 1000);

  decisions = feed(watcher, sourceId, 2, 5);
  assert.equal(decisions.filter(decision => decision.decision === 'suppressed').length, 0);
  assert.equal(decisions[0].transition, 'reopened');
  assert.equal(calls.length, 2);

  const audit = watcher.suppression.auditEntries();
  assert.ok(audit.some(entry => entry.reasonCode === 'SUPPRESSION_EXPIRED'));
  assert.ok(watcher.log.entries().some(entry => entry.reasonCode === 'SUPPRESSION_EXPIRED'));
});

test('a permanent ignore is auditable and revocable', () => {
  const clock = makeClock();
  const { watcher, calls, sourceId } = makeWatcher({ name: 'ignore', clock });

  feed(watcher, sourceId, 1, 0);
  const rule = watcher.ignore({
    fingerprint: fingerprint(),
    scope: { ...SCOPE, profileId: 'P1' },
    reason: 'duplicate emitter, fixed in the next release of the gateway',
    actor: 'watcher-agent',
  });

  assert.equal(rule.kind, 'ignore_until_revoked');
  assert.equal(rule.expiresAt, null);

  let decisions = feed(watcher, sourceId, 5, 1);
  assert.ok(decisions.every(decision => decision.decision === 'suppressed'));
  assert.equal(calls.length, 1);

  clock.advance(30 * DAY_MS);
  decisions = feed(watcher, sourceId, 1, 6);
  assert.ok(decisions.every(decision => decision.decision === 'suppressed'));

  watcher.revoke(rule.suppressionId, { actor: 'ops-oncall', reason: 'the fix did not land' });
  decisions = feed(watcher, sourceId, 2, 7);
  assert.equal(decisions.filter(decision => decision.decision === 'suppressed').length, 0);

  const audit = watcher.suppression.auditEntries();
  assert.ok(audit.some(entry => entry.reasonCode === 'SUPPRESSION_IGNORE_CREATED'));
  assert.ok(audit.some(entry => entry.reasonCode === 'SUPPRESSION_REVOKED' && entry.actor === 'ops-oncall'));
});

test('a scoped mute does not silence another profile', () => {
  const clock = makeClock();
  const { watcher, sourceId } = makeWatcher({ name: 'mute-scope', clock });

  feed(watcher, sourceId, 1, 0);
  watcher.mute({
    fingerprint: fingerprint(),
    scope: { ...SCOPE, profileId: 'P1' },
    reason: 'profile-specific outage, addressed separately',
    actor: 'watcher-agent',
    expiresAt: new Date(START + DAY_MS).toISOString(),
  });

  watcher.sources.get(sourceId).source.append(engineError({ eventId: 'E-other', userTaskId: 'U-other', profileId: 'P2' }));
  const decisions = drain(watcher, sourceId).flatMap(report => report.decisions);

  assert.equal(decisions[0].decision, 'aggregated');
  assert.equal(watcher.incidents.list().length, 1);
  const incident = watcher.incidents.list()[0];
  assert.deepEqual(incident.affectedProfileRefs.map(ref => ref.profileId).sort(), ['P1', 'P2']);
  assert.equal(incident.suppressedCount, 0);
  assert.equal(incident.count, 2);
});

test('a wildcard or unbound suppression rule is refused', () => {
  const clock = makeClock();
  const { watcher } = makeWatcher({ name: 'wildcard', clock });

  assert.throws(() => watcher.mute({ fingerprint: '*', scope: { kind: 'platform' }, reason: 'mute everything', actor: 'ops', expiresAt: new Date(START + DAY_MS).toISOString() }));
  assert.throws(() => watcher.mute({ fingerprint: fingerprint(), scope: { kind: 'platform' }, reason: 'mute the whole platform', actor: 'ops', expiresAt: new Date(START + DAY_MS).toISOString() }));
  assert.throws(() => watcher.mute({ fingerprint: fingerprint(), scope: { ...SCOPE, profileId: 'P1' }, reason: 'short', actor: 'ops', expiresAt: new Date(START + DAY_MS).toISOString() }));
  assert.throws(() => watcher.mute({ fingerprint: fingerprint(), scope: { ...SCOPE, profileId: 'P1' }, reason: 'a valid reason without an author', actor: '  ', expiresAt: new Date(START + DAY_MS).toISOString() }));
  assert.throws(() => watcher.mute({ fingerprint: fingerprint(), scope: { ...SCOPE, profileId: 'P1' }, reason: 'valid reason for a mute', actor: 'ops', expiresAt: new Date(START - 1000).toISOString() }));
  assert.equal(watcher.suppression.list().length, 0);
});

test('a severity escalation reopens the incident without splitting the fingerprint', () => {
  const clock = makeClock();
  const { watcher, calls, sourceId } = makeWatcher({ name: 'escalation', clock });

  watcher.sources.get(sourceId).source.append(engineError({ eventId: 'E-warning', userTaskId: 'U-warning', severity: 'warning' }));
  drain(watcher, sourceId);
  const incidentId = watcher.incidents.list()[0].incidentId;
  watcher.closeDiagnosticSlot(incidentId, 'completed');

  watcher.sources.get(sourceId).source.append(engineError({ eventId: 'E-escalated', userTaskId: 'U-escalated', severity: 'error' }));
  const decisions = drain(watcher, sourceId).flatMap(report => report.decisions);

  assert.equal(decisions.length, 1);
  assert.equal(decisions[0].transition, 'reopened');
  assert.equal(watcher.incidents.list().length, 1);
  assert.ok(watcher.log.entries().some(entry => entry.reasonCode === 'SEVERITY_ESCALATED'));
});