'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { makeClock, makeWatcher, engineError, drain, START } = require('./helpers');

test('a storm of 1000 events opens one incident and one dispatch, not 1000 calls', () => {
  const clock = makeClock();
  const { watcher, calls, sourceId } = makeWatcher({ name: 'storm', clock });

  for (let i = 0; i < 1000; i += 1) {
    watcher.sources.get(sourceId).source.append(engineError({
      eventId: `E${i}`,
      userTaskId: `U${i}`,
      runId: `R${i}`,
      occurredAt: new Date(START + i * 1000).toISOString(),
    }));
  }

  const reports = drain(watcher, sourceId);
  const decisions = reports.flatMap(report => report.decisions);

  assert.equal(decisions.length, 1000);
  assert.equal(new Set(decisions.map(decision => decision.incidentId)).size, 1);
  assert.equal(calls.length, 1);

  const incident = watcher.incidents.list()[0];
  assert.equal(incident.count, 1000);
  assert.equal(incident.suppressedCount, 0);
  assert.equal(incident.affectedTaskReports, 1000);
  assert.equal(incident.affectedTaskIds.length, 100);
  assert.equal(incident.affectedTaskIdsTruncated, true);
  assert.equal(incident.diagnosticSlot.eventCount, 1000);
  assert.equal(incident.diagnosticSlot.status, 'active');
  assert.equal(watcher.incidents.activeCount(), 1);
});

test('the original errors stay in the source log and no task is marked successful', () => {
  const clock = makeClock();
  const { watcher, sourceId } = makeWatcher({ name: 'retained', clock });

  for (let i = 0; i < 250; i += 1) {
    watcher.sources.get(sourceId).source.append(engineError({ eventId: `E${i}`, userTaskId: `U${i}` }));
  }
  drain(watcher, sourceId);

  assert.equal(watcher.sources.get(sourceId).source.size(), 250);
  const events = watcher.log.entries();
  assert.ok(!events.some(entry => entry.event.includes('task') && entry.event.includes('success')));
  assert.ok(!events.some(entry => entry.to === 'succeeded'));
  const incident = watcher.incidents.list()[0];
  assert.equal(incident.count, 250);
});

test('repeat events append to the single active diagnostic task instead of starting a new one', () => {
  const clock = makeClock();
  const { watcher, calls, sourceId } = makeWatcher({ name: 'append', clock });

  for (let i = 0; i < 5; i += 1) {
    watcher.sources.get(sourceId).source.append(engineError({ eventId: `E${i}`, userTaskId: `U${i}` }));
  }
  const reports = drain(watcher, sourceId);
  const decisions = reports.flatMap(report => report.decisions);

  assert.equal(calls.length, 1);
  assert.equal(new Set(decisions.map(decision => decision.diagnosticUserTaskId)).size, 1);
  const incident = watcher.incidents.list()[0];
  assert.equal(incident.diagnosticSlot.eventCount, 5);
  assert.equal(incident.dispatchCount, 1);
});

test('the per-incident dispatch budget bounds diagnosis attempts and the excess stays visible', () => {
  const clock = makeClock();
  const { watcher, calls, sourceId } = makeWatcher({
    name: 'budget',
    clock,
    config: { maxDispatchesPerIncident: 2 },
  });

  for (let i = 0; i < 3; i += 1) {
    watcher.sources.get(sourceId).source.append(engineError({ eventId: `E${i}`, userTaskId: `U${i}` }));
  }
  drain(watcher, sourceId);
  assert.equal(calls.length, 1);

  const incidentId = watcher.incidents.list()[0].incidentId;
  watcher.closeDiagnosticSlot(incidentId, 'completed');
  watcher.resolveIncident(incidentId, { actor: 'sandbox', reason: 'repair applied' });

  for (let i = 3; i < 6; i += 1) {
    watcher.sources.get(sourceId).source.append(engineError({ eventId: `E${i}`, userTaskId: `U${i}` }));
  }
  const reports = drain(watcher, sourceId);
  const decisions = reports.flatMap(report => report.decisions);
  assert.equal(decisions.filter(decision => decision.transition === 'reopened').length, 1);
  assert.equal(calls.length, 2);

  watcher.closeDiagnosticSlot(incidentId, 'completed');
  watcher.resolveIncident(incidentId, { actor: 'sandbox', reason: 'second repair' });
  for (let i = 6; i < 9; i += 1) {
    watcher.sources.get(sourceId).source.append(engineError({ eventId: `E${i}`, userTaskId: `U${i}` }));
  }
  drain(watcher, sourceId);

  assert.equal(calls.length, 2);
  assert.equal(watcher.summary().state.deferredCount > 0, true);
  assert.ok(watcher.dispatch.backlog().length <= 1);
});

test('one incident aggregates many affected profiles and tasks', () => {
  const clock = makeClock();
  const { watcher, sourceId } = makeWatcher({ name: 'multi-profile', clock });

  for (let i = 0; i < 12; i += 1) {
    watcher.sources.get(sourceId).source.append(engineError({
      eventId: `E${i}`,
      userTaskId: `U${i}`,
      profileId: `P${i % 3}`,
    }));
  }
  drain(watcher, sourceId);

  const incident = watcher.incidents.list()[0];
  assert.equal(incident.affectedProfileRefs.length, 3);
  assert.equal(incident.affectedTaskReports, 12);
  assert.equal(incident.affectedTaskIds.length, 12);
  assert.equal(incident.count, 12);
});
