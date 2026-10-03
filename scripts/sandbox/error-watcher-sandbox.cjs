#!/usr/bin/env node
'use strict';

// Сценарий этапа I09 для Error Watcher (карточка P27, эпик E6 #22).
//
// Одна команда: setup → run → evidence → teardown. Песочница живёт в
// `.sandbox/p27-<pid>/` (в .gitignore), наружу не ходит: только loopback и
// виртуальные часы, поэтому transcript воспроизводим побайтово — это проверяет
// `npm run evidence:verify` в CI.
//
// Запуск:
//   node scripts/sandbox/error-watcher-sandbox.cjs            # пишет evidence
//   node scripts/sandbox/error-watcher-sandbox.cjs --verify   # сверка с закоммиченным transcript

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const DEFAULT_OUT = path.join(ROOT, 'docs', 'evidence', 'p27-incident-aggregation');
const TRANSCRIPT_FILE = 'transcript.json';

const { createErrorWatcher } = require(path.join(ROOT, 'src', 'watcher', 'index.js'));
const { createIntakeServer } = require(path.join(ROOT, 'src', 'http', 'intake-server.js'));
const { hashKey } = require(path.join(ROOT, 'src', 'sources', 'push-intake.js'));
const { fingerprintFor } = require(path.join(ROOT, 'src', 'contract', 'fingerprint.js'));
const { normalizeErrorEvent } = require(path.join(ROOT, 'src', 'contract', 'error-event.js'));

const START = Date.parse('2026-10-03T09:00:00.000Z');
const DAY_MS = 24 * 60 * 60 * 1000;
let tick = 0;
function now() {
  return new Date(START + tick);
}
function advance(ms) {
  tick += ms;
}

const results = [];
let current = null;

function scenario(name, fault, fn) {
  current = { name, fault, steps: [], checks: [] };
  results.push(current);
  return fn(current);
}

function step(event, fields) {
  current.steps.push({ event, ...fields });
}

function check(name, passed, detail) {
  current.checks.push({ name, passed: Boolean(passed), detail: detail || null });
}

function assertEqual(name, actual, expected) {
  check(name, actual === expected, `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

function assertIncludes(name, haystack, needle) {
  check(name, String(haystack).includes(needle), `expected to find ${needle}`);
}

function makeRoot(name) {
  const root = path.join(ROOT, '.sandbox', `p27-${process.pid}`, name);
  fs.rmSync(root, { recursive: true, force: true });
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  return root;
}

const teardowns = [];

async function teardownAll() {
  for (const teardown of teardowns.splice(0).reverse()) {
    await teardown();
  }
}

const SOURCE_SPEC = {
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

function engineError({ eventId, userTaskId, runId, profileId = 'P1', severity = 'error', code = 'ENGINE_ZERO_COST', occurredAt, origin, stack }) {
  return {
    schemaVersion: 1,
    eventId,
    occurredAt: occurredAt || new Date(START).toISOString(),
    source: { service: 'telegram-gateway', release: 'sandbox', environment: 'sandbox' },
    scope: { kind: 'profile', tenantId: 'T1', profileId },
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
      stack: stack || 'Error: engine failed\n    at runAgent (/srv/runner/index.js:12:34)\n    at process (/srv/runner/worker.js:567:9)',
    },
    origin: origin || { kind: 'application', incidentId: null, diagnosticDepth: 0 },
  };
}

function platformError({ eventId, code = 'HOST_OUTAGE' }) {
  return {
    schemaVersion: 1,
    eventId,
    occurredAt: new Date(START).toISOString(),
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

/**
 * Изолированный стек этапа: зарегистрированный источник, точный fingerprint
 * store, scoped suppression, reconciliation и fake sink для dispatch-интентов.
 * LLM/OpenCode не вызываются: приёмник интентов — счётчик в памяти.
 */
function buildStack({ fault = 'success', config = {} } = {}) {
  const root = makeRoot(`stack-${fault}-${results.length}`);
  const calls = [];
  const watcher = createErrorWatcher({
    root,
    now,
    config: {
      maxDispatchesPerIncident: 3,
      globalDispatchBudgetPerWindow: 10,
      maxBacklog: 1000,
      maxSelfErrors: 3,
      ...config,
    },
    dispatcher: intent => {
      calls.push(intent.dispatchId);
      return { status: 'submitted', detail: 'fake sink' };
    },
  });
  watcher.registerSource(SOURCE_SPEC);
  return { root, watcher, calls, sourceId: SOURCE_SPEC.sourceId };
}

function feed(watcher, sourceId, count, { from = 0, profileId = 'P1', severity = 'error', code = 'ENGINE_ZERO_COST', origin } = {}) {
  const source = watcher.sources.get(sourceId).source;
  for (let i = 0; i < count; i += 1) {
    source.append(engineError({
      eventId: `E${from + i}`,
      userTaskId: `U${from + i}`,
      runId: `R${from + i}`,
      profileId,
      severity,
      code,
      origin,
      occurredAt: new Date(START + (from + i) * 1000).toISOString(),
    }));
  }
  return drain(watcher, sourceId);
}

function drain(watcher, sourceId) {
  const decisions = [];
  for (let guard = 0; guard < 10000; guard += 1) {
    const report = watcher.poll(sourceId);
    decisions.push(...report.decisions);
    if (report.polled === 0) break;
  }
  return decisions;
}

function fingerprintOf(event) {
  return fingerprintFor(normalizeErrorEvent(event).event);
}

async function run() {
  // 1. PR-26: шторм из 1000 событий с нулевым расходом → один инцидент, один dispatch.
  await scenario('storm-1000', 'zero-cost engine storm', async (report) => {
    const { watcher, calls, sourceId } = buildStack();
    step('storm.feed', { events: 1000, code: 'ENGINE_ZERO_COST', outcome: 'failed', costPerEvent: 0 });

    const decisions = feed(watcher, sourceId, 1000);
    const incidentIds = new Set(decisions.map(decision => decision.incisionId || decision.incidentId));
    const incident = watcher.incidents.list()[0];

    step('storm.aggregated', {
      incidents: watcher.incidents.list().length,
      events: incident.count,
      dispatchCalls: calls.length,
      activeDiagnosticSlots: watcher.incidents.summary().activeDiagnosticSlots,
      sourceLogEvents: watcher.sources.get(sourceId).source.size(),
    });
    assertEqual('the storm opens exactly one incident', watcher.incidents.list().length, 1);
    assertEqual('the storm costs one dispatch, not one thousand', calls.length, 1);
    assertEqual('every event is counted on the incident', incident.count, 1000);
    assertEqual('one active diagnostic task serves the whole storm', incident.diagnosticSlot.eventCount, 1000);
    assertEqual('the original errors stay in the source log', watcher.sources.get(sourceId).source.size(), 1000);
    assertEqual('no second diagnostic task is started', incident.dispatchCount, 1);
    assertEqual('the incident stays open', incident.state, 'open');
    assertIncludes('the log names the fingerprint', JSON.stringify(watcher.log.entries()), 'INCIDENT_DEDUPED');
  });

  // 2. Timed mute: причина, автор, срок; повторы агрегируются, не исчезают.
  await scenario('mute-timed', 'repeat events under a timed mute', async (report) => {
    const { watcher, calls, sourceId } = buildStack();
    feed(watcher, sourceId, 2);
    const incident = watcher.incidents.list()[0];
    const fingerprint = incident.fingerprint;

    const rule = watcher.mute({
      fingerprint,
      scope: { kind: 'profile', tenantId: 'T1', profileId: 'P1', sourceId: 'telegram-gateway' },
      reason: 'third-party outage, diagnosis already filed upstream',
      actor: 'watcher-agent',
      expiresAt: new Date(START + DAY_MS).toISOString(),
    });
    step('mute.created', { suppressionId: rule.suppressionId, kind: rule.kind, actor: rule.actor, expiresAt: rule.expiresAt });

    const decisions = feed(watcher, sourceId, 10, { from: 2 });
    step('mute.applied', {
      suppressed: decisions.filter(decision => decision.decision === 'suppressed').length,
      dispatchCalls: calls.length,
      incidentCount: incident.count,
      suppressedCount: incident.suppressedCount,
      sourceLogEvents: watcher.sources.get(sourceId).source.size(),
    });
    assertEqual('every repeat is suppressed', decisions.filter(decision => decision.decision === 'suppressed').length, 10);
    assertEqual('a muted storm costs no extra dispatch', calls.length, 1);
    assertEqual('suppressed events still count on the incident', incident.count, 12);
    assertEqual('suppressed events are counted separately', incident.suppressedCount, 10);
    assertEqual('the original errors are not deleted', watcher.sources.get(sourceId).source.size(), 12);
    assertIncludes('the mute is recorded with its reason', JSON.stringify(watcher.suppression.auditEntries()), rule.reason);
  });

  // 3. Expiry: после срока правило перестаёт матчиться, инцидент переоткрывается.
  await scenario('mute-expiry', 'mute expiry reopens the incident', async (report) => {
    const { watcher, calls, sourceId } = buildStack();
    feed(watcher, sourceId, 2);
    const incident = watcher.incidents.list()[0];
    watcher.closeDiagnosticSlot(incident.incidentId, 'completed');
    watcher.resolveIncident(incident.incidentId, { actor: 'sandbox', reason: 'repair applied' });

    watcher.mute({
      fingerprint: incident.fingerprint,
      scope: { kind: 'profile', tenantId: 'T1', profileId: 'P1', sourceId: 'telegram-gateway' },
      reason: 'waiting for the provider to fix the outage',
      actor: 'watcher-agent',
      expiresAt: new Date(START + DAY_MS).toISOString(),
    });
    const muted = feed(watcher, sourceId, 3, { from: 2 });
    assertEqual('events under the mute are suppressed', muted.every(decision => decision.decision === 'suppressed'), true);

    advance(DAY_MS + 60 * 1000);
    const after = feed(watcher, sourceId, 2, { from: 5 });
    step('mute.expired', {
      suppressed: after.filter(decision => decision.decision === 'suppressed').length,
      reopened: after.filter(decision => decision.transition === 'reopened').length,
      dispatchCalls: calls.length,
    });
    assertEqual('no event is suppressed after the expiry', after.filter(decision => decision.decision === 'suppressed').length, 0);
    assertEqual('the first event after the expiry reopens the incident', after[0].transition, 'reopened');
    assertEqual('the reopened incident is diagnosed once more', calls.length, 2);
    assertIncludes('the expiry is audited', JSON.stringify(watcher.suppression.auditEntries()), 'SUPPRESSION_EXPIRED');
  });

  // 4. Regression: решённый инцидент получает новое событие того же fingerprint.
  await scenario('regression', 'regression after a resolve', async (report) => {
    const { watcher, calls, sourceId } = buildStack();
    feed(watcher, sourceId, 2);
    const incident = watcher.incidents.list()[0];
    watcher.closeDiagnosticSlot(incident.incidentId, 'completed');
    watcher.resolveIncident(incident.incidentId, { actor: 'sandbox', reason: 'repair applied' });
    assertEqual('the incident is resolved', watcher.incidents.list()[0].state, 'resolved');

    const decisions = feed(watcher, sourceId, 2, { from: 2 });
    step('regression.reopened', {
      transition: decisions[0].transition,
      reopenCount: watcher.incidents.list()[0].reopenCount,
      dispatchCalls: calls.length,
    });
    assertEqual('the same fingerprint reopens the incident', decisions[0].transition, 'reopened');
    assertEqual('the reopen is counted', watcher.incidents.list()[0].reopenCount, 1);
    assertEqual('a reopened incident is diagnosed again', calls.length, 2);
  });

  // 5. Unknown profile: reconciliation, а не случайная доставка пользователю.
  await scenario('unknown-profile', 'profile error without a profile', async (report) => {
    const { watcher, calls, sourceId } = buildStack();
    const raw = engineError({ eventId: 'E-1', userTaskId: 'U-1' });
    delete raw.scope.profileId;
    watcher.sources.get(sourceId).source.append(raw);
    const decisions = drain(watcher, sourceId);

    step('reconciliation.quarantined', {
      decision: decisions[0].decision,
      delivery: decisions[0].delivery,
      incidents: watcher.incidents.list().length,
      dispatchCalls: calls.length,
      openReconciliation: watcher.reconciliation.openCount(),
    });
    assertEqual('the event is quarantined', decisions[0].decision, 'quarantined');
    assertEqual('no user delivery is attempted', decisions[0].delivery, 'none');
    assertEqual('no incident is opened', watcher.incidents.list().length, 0);
    assertEqual('no diagnosis is dispatched', calls.length, 0);
    assertEqual('the event waits for ops reconciliation', watcher.reconciliation.openCount(), 1);
    assertIncludes('the quarantine is logged', JSON.stringify(watcher.log.entries()), 'reconciliation.quarantined');
  });

  // 6. Незарегистрированный источник не парсится.
  await scenario('unregistered-source', 'event from an unregistered service', async (report) => {
    const { watcher, calls, sourceId } = buildStack();
    const raw = engineError({ eventId: 'E-1', userTaskId: 'U-1' });
    raw.source.service = 'some-other-service';
    watcher.sources.get(sourceId).source.append(raw);
    const decisions = drain(watcher, sourceId);

    assertEqual('the event is quarantined', decisions[0].decision, 'quarantined');
    assertEqual('the reason is the unregistered source', decisions[0].reasonCode, 'SOURCE_NOT_REGISTERED');
    assertEqual('no incident is opened', watcher.incidents.list().length, 0);
    assertEqual('no diagnosis is dispatched', calls.length, 0);
  });

  // 7. Platform outage: инцидент без профиля, доставки пользователям нет.
  await scenario('platform-outage', 'host outage without a profile', async (report) => {
    const root = makeRoot('stack-platform');
    const watcher = createErrorWatcher({ root, now });
    watcher.registerSource({
      ...SOURCE_SPEC,
      sourceId: 'runner-host-errors',
      service: 'runner-host',
      scopeRules: ['platform'],
    });
    const source = watcher.sources.get('runner-host-errors').source;
    for (let i = 0; i < 4; i += 1) {
      source.append(platformError({ eventId: `H${i}` }));
    }
    const decisions = drain(watcher, 'runner-host-errors');
    const incident = watcher.incidents.list()[0];

    step('platform.aggregated', {
      incidents: watcher.incidents.list().length,
      events: incident.count,
      scope: incident.scope.kind,
      affectedProfiles: incident.affectedProfileRefs.length,
      delivery: decisions[0].delivery,
    });
    assertEqual('the outage opens one platform incident', watcher.incidents.list().length, 1);
    assertEqual('the incident carries no profile', incident.affectedProfileRefs.length, 0);
    assertEqual('no user delivery is attempted', decisions[0].delivery, 'none');
    assertEqual('all events are counted', incident.count, 4);
  });

  // 8. Self-loop guard: ошибка самого watcher'а не порождает диагностику себя.
  await scenario('self-error', 'watcher reports its own failure', async (report) => {
    const { watcher, calls, sourceId } = buildStack();
    watcher.sources.get(sourceId).source.append(engineError({
      eventId: 'S-1',
      userTaskId: 'U-1',
      origin: { kind: 'watcher_diagnosis', incidentId: 'INC_1', diagnosticDepth: 0 },
    }));
    const decisions = drain(watcher, sourceId);

    step('self.recorded', {
      decision: decisions[0].decision,
      incidents: watcher.incidents.list().length,
      dispatchCalls: calls.length,
      selfErrors: watcher.selfErrors.count(),
    });
    assertEqual('the event is recorded as a watcher self error', decisions[0].decision, 'self_error');
    assertEqual('no incident is opened', watcher.incidents.list().length, 0);
    assertEqual('no diagnosis of itself is dispatched', calls.length, 0);
    assertEqual('the self error is kept in a bounded bucket', watcher.selfErrors.count(), 1);
  });

  // 9. Глубина диагностики: превышение лимита останавливает рекурсию.
  await scenario('diagnostic-depth', 'diagnostic task exceeds the depth limit', async (report) => {
    const { watcher, calls, sourceId } = buildStack({ config: { maxDiagnosticDepth: 1 } });
    watcher.sources.get(sourceId).source.append(engineError({
      eventId: 'S-1',
      userTaskId: 'U-1',
      origin: { kind: 'watcher_diagnosis', incidentId: 'INC_1', diagnosticDepth: 2 },
    }));
    const decisions = drain(watcher, sourceId);

    assertEqual('the deep diagnostic is stopped', decisions[0].decision, 'self_error');
    assertEqual('the depth is visible in the decision', decisions[0].diagnosticDepth, 2);
    assertEqual('no recursive diagnosis is dispatched', calls.length, 0);
  });

  // 10. Retention: ускоренные часы архивируют решённые инциденты, активные не трогают.
  await scenario('retention-ttl', 'accelerated clock archives resolved incidents', async (report) => {
    const { watcher, sourceId } = buildStack();
    feed(watcher, sourceId, 3);
    const incident = watcher.incidents.list()[0];
    watcher.resolveIncident(incident.incidentId, { actor: 'sandbox', reason: 'repair applied' });

    advance(91 * DAY_MS);
    const cleanup = watcher.cleanup();
    step('retention.applied', {
      archived: cleanup.incidents.archived,
      openIncidents: watcher.incidents.list().filter(item => item.state === 'open').length,
      cursor: watcher.sources.get(sourceId).reader.cursor(),
    });
    assertEqual('the resolved incident is archived after the TTL', cleanup.incidents.archived, 1);
    assertEqual('the aggregate survives the archive', watcher.incidents.list()[0].count, 3);
    assertEqual('the reader cursor is not erased', watcher.sources.get(sourceId).reader.cursor(), 3);

    feed(watcher, sourceId, 3, { from: 3 });
    advance(91 * DAY_MS);
    const second = watcher.cleanup();
    assertEqual('an active incident is never archived', second.incidents.archived, 0);
    assertEqual('the archived incident stays archived', watcher.incidents.list().filter(item => item.archived).length, 1);
  });

  // 11. Health alarm: независимый детерминированный сигнал, его не глушит mute.
  await scenario('health-alarm', 'backlog and self errors raise a deterministic alarm', async (report) => {
    const { watcher, sourceId } = buildStack({ config: { maxBacklog: 10, maxSelfErrors: 2 } });
    const healthy = watcher.health.evaluate();
    assertEqual('a drained watcher is healthy', healthy.status, 'ok');

    for (let i = 0; i < 25; i += 1) {
      watcher.sources.get(sourceId).source.append(engineError({ eventId: `E${i}`, userTaskId: `U${i}` }));
    }
    const backlog = watcher.health.evaluate();
    step('health.backlog', { status: backlog.status, reasons: backlog.reasons.map(reason => reason.code) });
    assertEqual('the backlog raises a failing alarm', backlog.status, 'failing');
    assertIncludes('the reason is the source backlog', JSON.stringify(backlog.reasons), 'SOURCE_BACKLOG');

    watcher.mute({
      fingerprint: fingerprintOf(engineError({ eventId: 'X' })),
      scope: { kind: 'profile', tenantId: 'T1', profileId: 'P1', sourceId: 'telegram-gateway' },
      reason: 'muted while the backlog is investigated',
      actor: 'watcher-agent',
      expiresAt: new Date(now().getTime() + DAY_MS).toISOString(),
    });
    const muted = watcher.health.evaluate();
    assertEqual('suppression does not silence the alarm', muted.status, 'failing');

    for (let i = 0; i < 4; i += 1) {
      watcher.sources.get(sourceId).source.append(engineError({
        eventId: `S${i}`,
        userTaskId: `US${i}`,
        origin: { kind: 'watcher_delivery', incidentId: null, diagnosticDepth: 0 },
      }));
    }
    drain(watcher, sourceId);
    const selfReport = watcher.health.evaluate();
    step('health.self-errors', { status: selfReport.status, reasons: selfReport.reasons.map(reason => reason.code) });
    assertIncludes('watcher self errors are visible', JSON.stringify(selfReport.reasons), 'SELF_ERRORS');
    assertEqual('the alarm id is deterministic for the same inputs', selfReport.alarmId, watcher.health.evaluate().alarmId);
  });

  // 12. Подключение внешней установки: ключ, scopes, durable receipt, dedup.
  await scenario('push-intake', 'external installation pushes an event', async (report) => {
    const root = makeRoot('stack-push');
    const apiKey = 'sandbox-watcher-key';
    const keyStore = new Map([[hashKey(apiKey), ['error:write']]]);
    const watcher = createErrorWatcher({ root, now });
    const entry = watcher.attachPushSource({
      ...SOURCE_SPEC,
      sourceId: 'external-installation-errors',
      service: 'external-installation',
      transport: 'http_push',
    }, { keyStore });
    const server = createIntakeServer({ intake: entry.intake });
    teardowns.push(() => server.stop());
    const { port } = await server.start();

    const event = engineError({ eventId: 'E-1', userTaskId: 'U-1' });
    event.source = { service: 'external-installation', release: 'sandbox', environment: 'sandbox' };

    const accepted = await new Promise((resolve, reject) => {
      const body = JSON.stringify(event);
      const req = require('http').request({
        host: '127.0.0.1',
        port,
        path: '/errors',
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(body),
          'x-watcher-key': apiKey,
          'x-watcher-scopes': 'error:write',
        },
      }, res => {
        const chunks = [];
        res.on('data', chunk => chunks.push(chunk));
        res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) }));
      });
      req.on('error', reject);
      req.end(body);
    });

    const duplicate = await new Promise((resolve, reject) => {
      const body = JSON.stringify(event);
      const req = require('http').request({
        host: '127.0.0.1',
        port,
        path: '/errors',
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(body),
          'x-watcher-key': apiKey,
          'x-watcher-scopes': 'error:write',
        },
      }, res => {
        const chunks = [];
        res.on('data', chunk => chunks.push(chunk));
        res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) }));
      });
      req.on('error', reject);
      req.end(body);
    });

    step('push.accepted', {
      status: accepted.status,
      reasonCode: accepted.body.reasonCode,
      duplicateStatus: duplicate.status,
      duplicateReasonCode: duplicate.body.reasonCode,
      storedEvents: entry.source.size(),
    });
    assertEqual('the event is accepted with a receipt', accepted.status, 202);
    assertEqual('the receipt confirms acceptance', accepted.body.reasonCode, 'EVENT_ACCEPTED');
    assertEqual('the same eventId is not stored twice', duplicate.body.duplicate, true);
    assertEqual('the source log holds one event', entry.source.size(), 1);

    const decisions = drain(watcher, entry.spec.sourceId);
    assertEqual('the pushed event is aggregated like a read one', decisions[0].decision, 'opened');
  });

  // 13. Переполнение журнала источника: dropped-count виден, курсор рестартит.
  await scenario('reader-truncation', 'source log rotated under the cursor', async (report) => {
    const { watcher, sourceId } = buildStack();
    const source = watcher.sources.get(sourceId).source;
    feed(watcher, sourceId, 5);
    assertEqual('the cursor consumed the log', watcher.sources.get(sourceId).reader.cursor(), 5);

    source.truncate();
    const truncated = watcher.poll(sourceId);
    step('reader.truncated', {
      dropped: truncated.dropped,
      truncated: truncated.truncated,
      cursor: truncated.cursor,
    });
    assertEqual('the dropped count stays visible', truncated.dropped, 5);
    assertEqual('the cursor restarts from the beginning', truncated.cursor, 0);
    assertIncludes('the truncation is logged', JSON.stringify(watcher.log.entries()), 'SOURCE_LOG_TRUNCATED');
  });

  // 14. Fidelity: что эмулировано и что требует живого провайдера.
  await scenario('fidelity', 'success', async (report) => {
    const { watcher, calls } = buildStack();
    step('fidelity', {
      dispatcher: 'in-memory fake sink (no LLM/OpenCode call)',
      clock: 'virtual',
      transport: 'loopback only',
      liveProvider: false,
      containsPersonalData: false,
    });
    assertEqual('the dispatcher is a fake sink', calls.length, 0);
    assertEqual('no live provider is touched', watcher.config.liveProvider === undefined, true);
  });

  await teardownAll();
  return results;
}

function renderTranscript(results) {
  const checks = results.flatMap(report => report.checks);
  const failed = checks.filter(entry => !entry.passed);
  return {
    schemaVersion: 1,
    card: 'P27',
    epic: 'E6 #22',
    stage: 'I09',
    contract: 'C12/C13 v1',
    occurredAt: new Date(START).toISOString(),
    clock: 'virtual',
    sandboxRoot: '.sandbox/p27-<pid>/',
    summary: {
      scenarios: results.length,
      checks: checks.length,
      passed: checks.length - failed.length,
      failed: failed.length,
      status: failed.length === 0 ? 'PASS' : 'FAIL',
    },
    scenarios: results.map(report => ({
      name: report.name,
      fault: report.fault,
      steps: report.steps,
      checks: report.checks,
    })),
    acceptance: {
      'AC-160': 'a storm of 1000 zero-cost events opens one incident and one dispatch; the source log keeps every original error',
      'AC-161': 'an unknown profile and an unregistered source go to ops reconciliation; no user delivery is attempted',
      'AC-162': 'a timed mute is recorded with a reason and an author; expiry and regression reopen the incident',
      'AC-270': 'one active diagnostic task per incident; repeat events append to it',
      'AC-272': 'suppression aggregates counts and never deletes the original errors or marks tasks successful',
      'AC-273': 'a wildcard or unbound suppression rule is refused; permanent ignore is auditable and revocable',
      'AC-274': 'an independent deterministic health alarm reports backlog, stale sources and watcher self errors',
      'AC-165': 'logs carry errorEvent/incident/sourceTask/diagnosticTask, fingerprint/count, mute/reopen/expiry and the self-loop guard',
    },
    fidelity: {
      dispatcher: 'in-memory fake sink',
      llmCalls: 0,
      openCodeCalls: 0,
      liveProvider: false,
      containsPersonalData: false,
      note: 'a green sandbox run is not a live provider test',
    },
  };
}

function sanitizeTranscript(transcript) {
  const raw = JSON.stringify(transcript);
  const forbidden = ['sandbox-watcher-key', '127.0.0.1', process.pid, ROOT];
  for (const needle of forbidden) {
    if (raw.includes(String(needle))) {
      throw new Error(`transcript is not sanitized: found "${String(needle).slice(0, 24)}"`);
    }
  }
  return transcript;
}

function writeEvidence(outDir, transcript) {
  fs.mkdirSync(outDir, { recursive: true, mode: 0o700 });
  const file = path.join(outDir, TRANSCRIPT_FILE);
  fs.writeFileSync(file, `${JSON.stringify(transcript, null, 2)}\n`, { mode: 0o600 });
  const hash = crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  fs.writeFileSync(path.join(outDir, 'transcript.sha256'), `${hash}\n`, { mode: 0o600 });
  return { file, hash };
}

function main() {
  const args = process.argv.slice(2);
  const verify = args.includes('--verify');
  const outIndex = args.indexOf('--out');
  const outDir = outIndex >= 0 ? path.resolve(args[outIndex + 1]) : DEFAULT_OUT;

  return run()
    .then(results => {
      const transcript = sanitizeTranscript(renderTranscript(results));
      if (verify) {
        const tempRoot = path.join(ROOT, '.sandbox', `p27-verify-${process.pid}`);
        fs.rmSync(tempRoot, { recursive: true, force: true });
        fs.mkdirSync(tempRoot, { recursive: true, mode: 0o700 });
        const tempDir = path.join(tempRoot, 'evidence');
        const generated = writeEvidence(tempDir, transcript);
        const committedPath = path.join(DEFAULT_OUT, TRANSCRIPT_FILE);
        if (!fs.existsSync(committedPath)) {
          process.stderr.write(`verify failed: no committed transcript at ${path.relative(ROOT, committedPath)}\n`);
          process.exit(1);
        }
        const committed = fs.readFileSync(committedPath, 'utf8');
        const actual = fs.readFileSync(generated.file, 'utf8');
        fs.rmSync(tempRoot, { recursive: true, force: true });
        if (committed !== actual) {
          const diffRoot = path.join(ROOT, '.sandbox', `p27-verify-diff-${process.pid}`);
          fs.mkdirSync(diffRoot, { recursive: true, mode: 0o700 });
          fs.writeFileSync(path.join(diffRoot, 'actual.json'), actual, { mode: 0o600 });
          fs.writeFileSync(path.join(diffRoot, 'committed.json'), committed, { mode: 0o600 });
          process.stderr.write(`verify failed: the committed transcript differs from a fresh run (dump: ${path.relative(ROOT, diffRoot)})\n`);
          process.exit(1);
        }
        process.stdout.write(`evidence verify ok: ${results.length} scenarios, ${transcript.summary.checks} checks, sha256 ${generated.hash}\n`);
        return;
      }
      const { hash } = writeEvidence(outDir, transcript);
      for (const report of results) {
        const failed = report.checks.filter(entry => !entry.passed);
        process.stdout.write(`${failed.length === 0 ? 'ok  ' : 'FAIL'} ${report.name} (${report.fault}) — ${report.checks.length - failed.length}/${report.checks.length}\n`);
      }
      process.stdout.write(`\n${transcript.summary.status}: ${transcript.summary.passed}/${transcript.summary.checks} checks, ${results.length} scenarios\n`);
      process.stdout.write(`evidence: ${path.relative(ROOT, path.join(outDir, TRANSCRIPT_FILE))} sha256 ${hash}\n`);
      if (transcript.summary.failed > 0) process.exit(1);
    })
    .catch(error => {
      process.stderr.write(`sandbox failed: ${String(error && error.stack ? error.stack : error)}\n`);
      process.exit(1);
    });
}

main();
