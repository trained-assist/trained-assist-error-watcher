'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { normalizeErrorEvent, allowsUserDelivery } = require('../src/contract/error-event');
const { fingerprintFor, fingerprintParts } = require('../src/contract/fingerprint');
const { engineError, platformError } = require('./helpers');

test('a valid profile error normalizes without violations', () => {
  const { event, violations } = normalizeErrorEvent(engineError({ eventId: 'E1', userTaskId: 'U1' }));
  assert.deepEqual(violations, []);
  assert.equal(event.eventId, 'E1');
  assert.equal(event.scope.profileId, 'P1');
  assert.equal(event.correlation.userTaskId, 'U1');
  assert.equal(event.error.outcome, 'failed');
  assert.equal(event.origin.diagnosticDepth, 0);
});

test('a profile error without a profile is a contract violation, not a guess', () => {
  const raw = engineError({ eventId: 'E2' });
  delete raw.scope.profileId;
  const { event, violations } = normalizeErrorEvent(raw);
  assert.equal(event, null);
  assert.ok(violations.includes('PROFILE_REQUIRED'));
  assert.ok(violations.includes('TENANT_REQUIRED') === false);
});

test('a platform error must not carry a profile', () => {
  const raw = platformError({ eventId: 'E3' });
  raw.scope.profileId = 'P1';
  const { violations } = normalizeErrorEvent(raw);
  assert.ok(violations.includes('PLATFORM_SCOPE_WITH_PROFILE'));
});

test('a known reply channel requires a destination ref', () => {
  const raw = engineError({ eventId: 'E4' });
  delete raw.replyContext.destinationRef;
  const { violations } = normalizeErrorEvent(raw);
  assert.ok(violations.includes('REPLY_CONTEXT_INCOMPLETE'));
});

test('an unknown reply status and an overlong safe summary are violations', () => {
  const badStatus = engineError({ eventId: 'E5' });
  badStatus.replyContext.status = 'maybe';
  assert.ok(normalizeErrorEvent(badStatus).violations.includes('REPLY_CONTEXT_STATUS_INVALID'));

  const longSummary = engineError({ eventId: 'E6' });
  longSummary.error.safeSummary = 'x'.repeat(241);
  assert.ok(normalizeErrorEvent(longSummary).violations.includes('SAFE_SUMMARY_INVALID'));
});

test('only a profile error with a known channel may be delivered to a user', () => {
  assert.equal(allowsUserDelivery(normalizeErrorEvent(engineError({ eventId: 'E7' })).event), true);

  const webOnly = engineError({ eventId: 'E8' });
  webOnly.replyContext = { channel: null, destinationRef: null, status: 'web_only' };
  assert.equal(allowsUserDelivery(normalizeErrorEvent(webOnly).event), false);

  assert.equal(allowsUserDelivery(normalizeErrorEvent(platformError({ eventId: 'E9' })).event), false);
});

test('the fingerprint is exact and ignores volatile parts of the same defect', () => {
  const first = engineError({ eventId: 'E10', userTaskId: 'U10', runId: 'R10' });
  const second = engineError({ eventId: 'E11', userTaskId: 'U11', runId: 'R11', profileId: 'P2' });
  second.error.stack = 'Error: engine failed\n    at runAgent (/srv/runner/index.js:999:11)\n    at process (/srv/runner/worker.js:12345:1)';
  second.occurredAt = '2026-10-04T10:00:00.000Z';

  assert.equal(fingerprintFor(first), fingerprintFor(second));
  assert.match(fingerprintFor(first), /^[0-9a-f]{64}$/);
});

test('a different error class, operation or code version is a different fingerprint', () => {
  const base = engineError({ eventId: 'E12' });
  const otherClass = engineError({ eventId: 'E13', code: 'PROVIDER_AUTH_EXPIRED' });
  const otherOperation = engineError({ eventId: 'E14' });
  otherOperation.error.operation = 'submitTask';
  const otherVersion = engineError({ eventId: 'E15' });
  otherVersion.error.codeVersion = 'runner@2';

  const baseFingerprint = fingerprintFor(base);
  assert.notEqual(baseFingerprint, fingerprintFor(otherClass));
  assert.notEqual(baseFingerprint, fingerprintFor(otherOperation));
  assert.notEqual(baseFingerprint, fingerprintFor(otherVersion));
});

test('severity is not part of the fingerprint: an escalation reopens, not splits', () => {
  const base = engineError({ eventId: 'E16', severity: 'warning' });
  const escalated = engineError({ eventId: 'E17', severity: 'error' });
  assert.equal(fingerprintFor(base), fingerprintFor(escalated));
  assert.deepEqual(fingerprintParts(base).stackLocation, fingerprintParts(escalated).stackLocation);
});
