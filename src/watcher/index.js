'use strict';

// Error Watcher: читает зарегистрированные источники, агрегирует события в
// инциденты по точному fingerprint, применяет scoped suppression и выдаёт
// не более одного dispatch-интента на активную diagnostic Task. LLM/OpenCode
// диагностика, отчёт и issue — отдельная карточка (P28); здесь только
// агрегация, suppression и reconciliation.

const path = require('path');

const { createEventLog } = require('../contract/event-log');
const { normalizeErrorEvent, allowsUserDelivery } = require('../contract/error-event');
const { fingerprintFor } = require('../contract/fingerprint');
const { createSourceRegistry } = require('../sources/registry');
const { createEventSource } = require('../sources/event-source');
const { createSourceReader } = require('../sources/reader');
const { createPushIntake } = require('../sources/push-intake');
const { createIncidentStore } = require('../store/incidents');
const { createSuppressionStore } = require('../store/suppression');
const { createReconciliationStore } = require('../store/reconciliation');
const { createDispatchLedger } = require('../store/dispatch');
const { createHealthAlarm } = require('../ops/health');
const { createSelfErrorBucket } = require('./self-errors');
const { DEFAULT_CONFIG: DEFAULT_RETENTION } = require('../store/retention');

const DEFAULT_CONFIG = {
  maxDiagnosticDepth: 1,
  maxDispatchesPerIncident: 3,
  globalDispatchBudgetPerWindow: 10,
  dispatchWindowMs: 60 * 60 * 1000,
  maxAffectedRefs: 20,
  defaultMuteMs: 24 * 60 * 60 * 1000,
  maxBacklog: 1000,
  maxPendingDispatch: 5,
  maxOpenIncidents: 50,
  maxReconciliationAgeMs: 24 * 60 * 60 * 1000,
  maxSelfErrors: 3,
  ...DEFAULT_RETENTION,
};

function isSelfOrigin(origin) {
  return Boolean(origin && typeof origin.kind === 'string' && origin.kind.startsWith('watcher'));
}

/**
 * @param {object} options
 * @param {string} options.root изолированный корень песочницы
 * @param {() => Date} [options.now]
 * @param {object} [options.config]
 * @param {string} [options.logFile]
 * @param {(intent: object) => object} [options.dispatcher] приёмник dispatch-интентов (fake sink в песочнице)
 */
function createErrorWatcher({ root, now = () => new Date(), config = {}, logFile, dispatcher } = {}) {
  if (!root) throw new Error('error watcher requires an isolated root');
  const clock = typeof now === 'function' ? now : () => new Date();
  const mergedConfig = { ...DEFAULT_CONFIG, ...config };
  const log = createEventLog({ file: logFile || path.join(root, 'watcher-events.jsonl'), now: clock });

  const registry = createSourceRegistry({ log, now: clock });
  const incidents = createIncidentStore({ root, log, now: clock, config: mergedConfig });
  const suppression = createSuppressionStore({ root, log, now: clock, config: mergedConfig });
  const reconciliation = createReconciliationStore({ root, log, now: clock });
  const dispatch = createDispatchLedger({ root, log, now: clock, config: mergedConfig });
  const selfErrors = createSelfErrorBucket({ root, log, now: clock });

  const sources = new Map();
  const serviceIndex = new Map();
  const state = { deferredCount: 0, ingestedCount: 0, suppressedCount: 0, quarantinedCount: 0, selfErrorCount: 0 };

  const health = createHealthAlarm({
    root,
    sources: [],
    incidents,
    dispatch,
    reconciliation,
    log,
    now: clock,
    config: mergedConfig,
  });

  function registerSource(spec, { source, reader } = {}) {
    const registered = registry.register(spec);
    const entrySource = source || createEventSource({ root, sourceId: registered.sourceId, now: clock });
    const entryReader = reader || createSourceReader({ root, sourceId: registered.sourceId, source: entrySource, log, now: clock });
    const entry = { spec: registered, source: entrySource, reader: entryReader, intake: null };
    sources.set(registered.sourceId, entry);
    serviceIndex.set(registered.service, registered.sourceId);
    health.setSources([
      ...health.sources(),
      {
        sourceId: registered.sourceId,
        source: entrySource,
        reader: entryReader,
        freshnessMs: registered.health.freshnessMs,
        health: registered.health,
      },
    ]);
    return entry;
  }

  function attachPushSource(spec, { keyStore }) {
    const entry = registerSource(spec);
    entry.intake = createPushIntake({ root, sourceId: entry.spec.sourceId, source: entry.source, keyStore, log, now: clock });
    return entry;
  }

  function sourceForEvent(event) {
    const service = event && event.source ? event.source.service : null;
    if (!service) return { entry: null, reasonCode: 'SOURCE_SERVICE_REQUIRED' };
    const sourceId = serviceIndex.get(service);
    if (!sourceId) return { entry: null, reasonCode: 'SOURCE_NOT_REGISTERED' };
    return { entry: sources.get(sourceId), reasonCode: null };
  }

  function dispatchIntent(incident, event, slot) {
    if (!incidents.canDispatch(incident)) {
      state.deferredCount += 1;
      log.write('diagnosis.deferred', {
        incidentId: incident.incidentId,
        diagnosticUserTaskId: slot ? slot.diagnosticUserTaskId : null,
        from: 'incident',
        to: 'deferred',
        reasonCode: 'DISPATCH_BUDGET_EXHAUSTED',
        detail: 'the per-incident dispatch budget is exhausted; the excess stays visible in the backlog',
        fingerprint: incident.fingerprint,
      });
      return { dispatchId: null, reasonCode: 'DISPATCH_BUDGET_EXHAUSTED' };
    }
    if (!dispatch.canDispatch(clock())) {
      state.deferredCount += 1;
      log.write('diagnosis.deferred', {
        incidentId: incident.incidentId,
        diagnosticUserTaskId: slot ? slot.diagnosticUserTaskId : null,
        from: 'incident',
        to: 'deferred',
        reasonCode: 'GLOBAL_BUDGET_EXHAUSTED',
        detail: 'the global dispatch window budget is exhausted; the excess stays visible in the backlog',
        fingerprint: incident.fingerprint,
      });
      return { dispatchId: null, reasonCode: 'GLOBAL_BUDGET_EXHAUSTED' };
    }
    const intent = dispatch.record({
      incidentId: incident.incidentId,
      diagnosticUserTaskId: slot.diagnosticUserTaskId,
      fingerprint: incident.fingerprint,
      reasonCode: 'DIAGNOSIS_DISPATCHED',
      eventIds: [event.eventId],
    });
    incidents.countDispatch(incident);
    if (dispatcher) {
      const outcome = dispatcher(intent);
      dispatch.receipt(intent.dispatchId, { status: outcome && outcome.status === 'failed' ? 'failed' : 'submitted', detail: outcome ? outcome.detail : null });
    }
    return { dispatchId: intent.dispatchId, reasonCode: 'DIAGNOSIS_DISPATCHED' };
  }

  function ingestEvent(rawEvent) {
    const { event, violations } = normalizeErrorEvent(rawEvent);
    if (!event) {
      state.quarantinedCount += 1;
      const item = reconciliation.quarantine({ event: null, violations, reasonCode: 'EVENT_NOT_OBJECT' });
      return { eventId: null, fingerprint: null, decision: 'quarantined', incidentId: null, transition: null, suppressionId: null, dispatchId: null, delivery: 'none', reasonCode: 'EVENT_NOT_OBJECT', reconciliationId: item.reconciliationId };
    }

    if (isSelfOrigin(event.origin) || event.origin.diagnosticDepth > mergedConfig.maxDiagnosticDepth) {
      state.selfErrorCount += 1;
      selfErrors.record(event, event.origin.diagnosticDepth > mergedConfig.maxDiagnosticDepth ? 'DIAGNOSTIC_DEPTH_EXCEEDED' : 'WATCHER_SELF_ORIGIN');
      return {
        eventId: event.eventId,
        fingerprint: null,
        decision: 'self_error',
        incidentId: null,
        transition: null,
        suppressionId: null,
        dispatchId: null,
        delivery: 'none',
        reasonCode: 'WATCHER_SELF_ERROR',
        diagnosticDepth: event.origin.diagnosticDepth,
        originKind: event.origin.kind,
      };
    }

    const { entry, reasonCode } = sourceForEvent(event);
    if (!entry) {
      state.quarantinedCount += 1;
      const item = reconciliation.quarantine({ event, violations: [reasonCode], reasonCode });
      return { eventId: event.eventId, fingerprint: null, decision: 'quarantined', incidentId: null, transition: null, suppressionId: null, dispatchId: null, delivery: 'none', reasonCode, reconciliationId: item.reconciliationId };
    }

    const fingerprint = fingerprintFor(event);
    const scope = { kind: event.scope.kind, tenantId: event.scope.tenantId, profileId: event.scope.profileId, sourceId: event.source.service };
    const matched = suppression.match(fingerprint, scope, clock());

    if (matched.rule) {
      const { incident } = incidents.recordSuppressed(event, fingerprint, matched.rule.suppressionId);
      state.ingestedCount += 1;
      state.suppressedCount += 1;
      log.write('errorEvent.suppressed', {
        eventId: event.eventId,
        incidentId: incident.incidentId,
        from: 'watcher',
        to: 'suppressed',
        reasonCode: 'EVENT_SUPPRESSED',
        detail: `suppression ${matched.rule.suppressionId} applied; the original error stays in the source log`,
        fingerprint,
        suppressionId: matched.rule.suppressionId,
        count: incident.count,
        suppressedCount: incident.suppressedCount,
      });
      return {
        eventId: event.eventId,
        fingerprint,
        decision: 'suppressed',
        incidentId: incident.incidentId,
        transition: 'suppressed',
        suppressionId: matched.rule.suppressionId,
        dispatchId: null,
        delivery: 'none',
        reasonCode: 'EVENT_SUPPRESSED',
        count: incident.count,
        suppressedCount: incident.suppressedCount,
      };
    }

    if (matched.expired.length > 0) {
      log.write('incident.reopen_eligible', {
        incidentId: null,
        from: 'suppression',
        to: 'eligible',
        reasonCode: 'SUPPRESSION_EXPIRED',
        detail: `${matched.expired.length} suppression rule(s) expired; the next event reopens the incident for diagnosis`,
        fingerprint,
        expiredSuppressionIds: matched.expired.map(rule => rule.suppressionId),
      });
    }

    const { incident, transition } = incidents.ingest(event, fingerprint);
    state.ingestedCount += 1;
    const delivery = allowsUserDelivery(event) ? 'known_channel' : event.replyContext.status === 'web_only' ? 'web_only' : 'none';

    let dispatchId = null;
    let dispatchReason = null;
    let diagnosticUserTaskId = null;
    if (transition === 'opened' || transition === 'reopened') {
      const { slot, created, reasonCode: slotReason } = incidents.openDiagnosticSlot(incident);
      if (slot) {
        diagnosticUserTaskId = slot.diagnosticUserTaskId;
        incidents.appendToDiagnosticSlot(incident, event);
        if (created) {
          const outcome = dispatchIntent(incident, event, slot);
          dispatchId = outcome.dispatchId;
          dispatchReason = outcome.reasonCode;
        }
      } else {
        dispatchReason = slotReason;
        state.deferredCount += 1;
      }
    } else if (incident.diagnosticSlot && incident.diagnosticSlot.status === 'active') {
      incidents.appendToDiagnosticSlot(incident, event);
      diagnosticUserTaskId = incident.diagnosticSlot.diagnosticUserTaskId;
    }

    log.write(transition === 'opened' ? 'incident.opened' : transition === 'reopened' ? 'incident.reopened' : 'incident.deduped', {
      eventId: event.eventId,
      incidentId: incident.incidentId,
      diagnosticUserTaskId,
      from: 'watcher',
      to: transition,
      reasonCode: transition === 'opened' ? 'INCIDENT_OPENED' : transition === 'reopened' ? 'INCIDENT_REOPENED' : 'INCIDENT_DEDUPED',
      detail: transition === 'deduped'
        ? 'the event joined the existing incident and its active diagnostic task; no second dispatch'
        : 'the incident is open with one active diagnostic task',
      fingerprint,
      count: incident.count,
      suppressedCount: incident.suppressedCount,
      affectedProfileCount: incident.affectedProfileRefs.length,
      affectedTaskReports: incident.affectedTaskReports,
      dispatchId,
      reasonCode: dispatchReason,
      profileId: event.scope.kind === 'profile' ? event.scope.profileId : null,
      userTaskId: event.correlation.userTaskId || null,
      runId: event.correlation.runId || null,
    });

    return {
      eventId: event.eventId,
      fingerprint,
      decision: transition === 'deduped' ? 'aggregated' : transition,
      incidentId: incident.incidentId,
      transition,
      suppressionId: null,
      dispatchId,
      diagnosticUserTaskId,
      delivery,
      reasonCode: dispatchReason || 'INCIDENT_AGGREGATED',
      count: incident.count,
      suppressedCount: incident.suppressedCount,
      affectedProfileCount: incident.affectedProfileRefs.length,
      affectedTaskReports: incident.affectedTaskReports,
    };
  }

  function poll(sourceId) {
    const entry = sourceId ? sources.get(sourceId) : null;
    if (!entry) throw new Error(`unknown source "${sourceId}"`);
    const result = entry.reader.poll();
    registry.markSeen(entry.spec.sourceId);
    const decisions = result.events.map(event => ingestEvent(event));
    return {
      sourceId: entry.spec.sourceId,
      polled: result.events.length,
      duplicates: result.duplicates,
      dropped: result.dropped,
      truncated: result.truncated,
      cursor: result.cursor,
      decisions,
    };
  }

  function pollAll() {
    return [...sources.keys()].map(sourceId => poll(sourceId));
  }

  function mute({ fingerprint, scope, reason, actor, expiresAt }) {
    const rule = suppression.create({ kind: 'mute_until', fingerprint, scope, reason, actor, expiresAt });
    log.write('suppression.created', {
      suppressionId: rule.suppressionId,
      from: 'none',
      to: 'created',
      reasonCode: 'SUPPRESSION_MUTE_CREATED',
      detail: `timed mute by ${rule.actor}: ${rule.reason}`,
      fingerprint,
      scope,
      expiresAt: rule.expiresAt,
      actor: rule.actor,
      reason: rule.reason,
    });
    return rule;
  }

  function ignore({ fingerprint, scope, reason, actor }) {
    const rule = suppression.create({ kind: 'ignore_until_revoked', fingerprint, scope, reason, actor });
    log.write('suppression.created', {
      suppressionId: rule.suppressionId,
      from: 'none',
      to: 'created',
      reasonCode: 'SUPPRESSION_IGNORE_CREATED',
      detail: `permanent ignore by ${rule.actor}: ${rule.reason}`,
      fingerprint,
      scope,
      actor: rule.actor,
      reason: rule.reason,
    });
    return rule;
  }

  function revoke(suppressionId, details) {
    return suppression.revoke(suppressionId, details);
  }

  function resolveIncident(incidentId, details) {
    return incidents.resolve(incidentId, details);
  }

  function closeDiagnosticSlot(incidentId, status) {
    const incident = incidents.get(incidentId);
    if (!incident) return null;
    return incidents.closeDiagnosticSlot(incident, status);
  }

  function cleanup() {
    const nowDate = clock();
    return {
      incidents: incidents.cleanup(nowDate),
      suppression: suppression.cleanup(nowDate),
      reconciliation: reconciliation.cleanup(nowDate),
      selfErrors: selfErrors.cleanup(),
    };
  }

  function summary() {
    return {
      state: { ...state },
      incidents: incidents.summary(),
      dispatch: dispatch.counts(),
      reconciliation: { open: reconciliation.openCount() },
      selfErrors: selfErrors.count(),
      suppression: {
        rules: suppression.list().length,
        active: suppression.list().filter(rule => suppression.isActive(rule, clock())).length,
      },
      sources: [...sources.values()].map(entry => ({
        sourceId: entry.spec.sourceId,
        service: entry.spec.service,
        transport: entry.spec.transport,
        cursor: entry.reader.cursor(),
        delivered: entry.reader.deliveredCount(),
        backlog: Math.max(0, entry.source.size() - entry.reader.cursor()),
      })),
    };
  }

  return {
    root,
    config: mergedConfig,
    log,
    registry,
    incidents,
    suppression,
    reconciliation,
    dispatch,
    selfErrors,
    health,
    sources,
    registerSource,
    attachPushSource,
    ingestEvent,
    poll,
    pollAll,
    mute,
    ignore,
    revoke,
    resolveIncident,
    closeDiagnosticSlot,
    cleanup,
    summary,
  };
}

module.exports = { createErrorWatcher, DEFAULT_CONFIG, isSelfOrigin };
