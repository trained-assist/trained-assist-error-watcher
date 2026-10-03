'use strict';

// Точный store инцидентов: fingerprint-индекс, счётчики дублей, одна активная
// diagnostic Task на инцидент, reopen по regression/expiry/severity/scope.
// Suppression ничего не удаляет: исходные события остаются в журнале источника,
// здесь живут только агрегаты и ссылки.

const crypto = require('crypto');
const path = require('path');
const { appendLine, readState, writeState } = require('./jsonl');
const { isExpired } = require('./retention');

const TRANSITIONS_FILE = 'incidents.jsonl';
const STATE_FILE = 'incidents-state.json';

const SEVERITY_RANK = { info: 0, warning: 1, error: 2 };
const INCIDENT_STATES = ['open', 'resolved'];
const SLOT_STATUSES = ['active', 'completed', 'failed', 'budget_exhausted'];

function incidentIdFor(fingerprint, scope) {
  const key = [fingerprint, scope.kind, scope.tenantId || '-', scope.sourceId].join('::');
  return `INC_${crypto.createHash('sha256').update(key).digest('hex').slice(0, 24)}`;
}

function diagnosticTaskIdFor(incidentId, attempt) {
  return `diag_${crypto.createHash('sha256').update(`${incidentId}:${attempt}`).digest('hex').slice(0, 24)}`;
}

function scopeOf(event) {
  return {
    kind: event.scope.kind,
    tenantId: event.scope.tenantId || null,
    sourceId: event.source.service,
  };
}

/**
 * @param {object} options
 * @param {string} options.root изолированный корень watcher'а
 * @param {object} [options.log]
 * @param {() => Date} [options.now]
 * @param {object} [options.config]
 */
function createIncidentStore({ root, log, now = () => new Date(), config = {} } = {}) {
  if (!root) throw new Error('incident store requires an isolated root');
  const transitionsFile = path.join(root, TRANSITIONS_FILE);
  const stateFile = path.join(root, STATE_FILE);

  const maxDispatchesPerIncident = Number.isInteger(config.maxDispatchesPerIncident) ? config.maxDispatchesPerIncident : 3;
  const maxAffectedRefs = Number.isInteger(config.maxAffectedRefs) ? config.maxAffectedRefs : 20;
  const maxTaskIdsSample = Number.isInteger(config.maxTaskIdsSample) ? config.maxTaskIdsSample : 100;
  const incidentTtlMs = Number.isFinite(config.incidentTtlMs) ? config.incidentTtlMs : 90 * 24 * 60 * 60 * 1000;

  let state = readState(stateFile, { incidents: {} });
  if (!state || typeof state !== 'object' || !state.incidents) state = { incidents: {} };

  function persist() {
    writeState(stateFile, state);
  }

  function transition(incident, from, to, reasonCode, detail) {
    const entry = {
      at: now().toISOString(),
      incidentId: incident.incidentId,
      fingerprint: incident.fingerprint,
      from,
      to,
      reasonCode,
      detail: detail || null,
    };
    appendLine(transitionsFile, entry);
    incident.transitions.push(entry);
    if (incident.transitions.length > 50) {
      incident.transitions = incident.transitions.slice(-50);
    }
    return entry;
  }

  function findIncident(fingerprint, scope) {
    const incidentId = incidentIdFor(fingerprint, scope);
    return { incidentId, incident: state.incidents[incidentId] || null };
  }

  function openIncident(event, fingerprint) {
    const scope = scopeOf(event);
    const incidentId = incidentIdFor(fingerprint, scope);
    const incident = {
      incidentId,
      fingerprint,
      scope,
      sourceId: event.source.service,
      service: event.source.service,
      errorClass: event.error.code,
      operation: event.error.operation,
      codeVersion: event.error.codeVersion || event.source.codeVersion || null,
      state: 'open',
      severity: event.error.severity,
      count: 1,
      suppressedCount: 0,
      firstSeenAt: event.occurredAt,
      lastSeenAt: event.occurredAt,
      affectedProfileRefs: [],
      affectedTaskIds: [],
      affectedTaskRefs: [],
      affectedTaskReports: 0,
      affectedProfileRefsTruncated: false,
      affectedTaskIdsTruncated: false,
      diagnosticSlot: null,
      dispatchCount: 0,
      reopenCount: 0,
      resolvedAt: null,
      archived: false,
      transitions: [],
    };
    addAffectedRef(incident, event);
    state.incidents[incidentId] = incident;
    const entry = transition(incident, null, 'open', 'INCIDENT_OPENED', 'first event of this fingerprint in this scope');
    persist();
    return { incident, transition: 'opened', reasonCode: entry.reasonCode };
  }

  function addAffectedRef(incident, event) {
    const profileId = event.scope.kind === 'profile' ? event.scope.profileId : null;
    const tenantId = event.scope.tenantId || null;
    if (profileId) {
      const existing = incident.affectedProfileRefs.find(ref => ref.profileId === profileId && ref.tenantId === tenantId);
      if (existing) {
        existing.count += 1;
        existing.lastSeenAt = event.occurredAt;
      } else if (incident.affectedProfileRefs.length < maxAffectedRefs) {
        incident.affectedProfileRefs.push({
          profileId,
          tenantId,
          count: 1,
          firstSeenAt: event.occurredAt,
          lastSeenAt: event.occurredAt,
        });
      } else {
        incident.affectedProfileRefsTruncated = true;
      }
    }

    const userTaskId = event.correlation.userTaskId || null;
    if (!userTaskId) return;
    incident.affectedTaskReports += 1;
    if (!incident.affectedTaskIdsTruncated) {
      if (incident.affectedTaskIds.includes(userTaskId)) return;
      if (incident.affectedTaskIds.length >= maxTaskIdsSample) {
        incident.affectedTaskIdsTruncated = true;
        return;
      }
      incident.affectedTaskIds.push(userTaskId);
    }
    if (incident.affectedTaskRefs.length < maxAffectedRefs) {
      incident.affectedTaskRefs.push({
        userTaskId,
        runId: event.correlation.runId || null,
        profileId,
        at: event.occurredAt,
      });
    }
  }

  /**
   * Агрегация события. Возвращает переход: opened | deduped | reopened.
   */
  function ingest(event, fingerprint) {
    const scope = scopeOf(event);
    const { incidentId, incident } = findIncident(fingerprint, scope);
    if (!incident) return openIncident(event, fingerprint);

    incident.count += 1;
    incident.lastSeenAt = event.occurredAt;
    addAffectedRef(incident, event);

    if (incident.state === 'resolved') {
      incident.state = 'open';
      incident.resolvedAt = null;
      incident.reopenCount += 1;
      const entry = transition(incident, 'resolved', 'open', 'REGRESSION_AFTER_RESOLVE', 'a resolved incident received a new event of the same fingerprint');
      persist();
      return { incident, transition: 'reopened', reasonCode: entry.reasonCode };
    }

    if ((SEVERITY_RANK[event.error.severity] || 0) > (SEVERITY_RANK[incident.severity] || 0)) {
      const previous = incident.severity;
      incident.severity = event.error.severity;
      const entry = transition(incident, previous, incident.severity, 'SEVERITY_ESCALATED', 'the same fingerprint arrived with a higher severity');
      persist();
      return { incident, transition: 'reopened', reasonCode: entry.reasonCode };
    }

    const entry = transition(incident, 'open', 'open', 'INCIDENT_DEDUPED', 'repeat event aggregated into the existing incident; no second diagnosis');
    persist();
    return { incident, transition: 'deduped', reasonCode: entry.reasonCode };
  }

  /**
   * Событие пришло под активной suppression-правилом. Инцидент не удаляется и не
   * закрывается: копим count/suppressedCount, исходники остаются в журнале.
   */
  function recordSuppressed(event, fingerprint, suppressionId) {
    const scope = scopeOf(event);
    const { incident } = findIncident(fingerprint, scope);
    if (!incident) return openIncident(event, fingerprint);
    incident.count += 1;
    incident.suppressedCount += 1;
    incident.lastSeenAt = event.occurredAt;
    addAffectedRef(incident, event);
    const entry = transition(incident, incident.state, incident.state, 'INCIDENT_SUPPRESSED', `event aggregated under suppression ${suppressionId}; no diagnosis, no delivery`);
    persist();
    return { incident, transition: 'suppressed', reasonCode: entry.reasonCode };
  }

  /**
   * Одна активная diagnostic Task на инцидент (AC-270). Новые события дополняют
   * её, второй слот не открывается. Возвращает существующий слот, если он активен.
   */
  function openDiagnosticSlot(incident) {
    if (incident.diagnosticSlot && incident.diagnosticSlot.status === 'active') {
      return { slot: incident.diagnosticSlot, created: false };
    }
    if (incident.dispatchCount >= maxDispatchesPerIncident) {
      return { slot: null, created: false, reasonCode: 'DISPATCH_BUDGET_EXHAUSTED' };
    }
    const attempt = incident.dispatchCount + 1;
    const slot = {
      diagnosticUserTaskId: diagnosticTaskIdFor(incident.incidentId, attempt),
      incidentId: incident.incidentId,
      status: 'active',
      openedAt: now().toISOString(),
      eventCount: 0,
      dispatchCount: 0,
    };
    incident.diagnosticSlot = slot;
    transition(incident, 'open', 'open', 'DIAGNOSTIC_SLOT_OPENED', `one active diagnostic task ${slot.diagnosticUserTaskId}; further events append to it`);
    persist();
    return { slot, created: true };
  }

  function appendToDiagnosticSlot(incident, event) {
    if (!incident.diagnosticSlot || incident.diagnosticSlot.status !== 'active') return null;
    incident.diagnosticSlot.eventCount += 1;
    incident.diagnosticSlot.lastEventAt = event.occurredAt;
    persist();
    return incident.diagnosticSlot;
  }

  function closeDiagnosticSlot(incident, status) {
    if (!incident.diagnosticSlot) return null;
    const slot = incident.diagnosticSlot;
    if (!SLOT_STATUSES.includes(status)) throw new Error(`unknown diagnostic slot status "${status}"`);
    slot.status = status;
    slot.closedAt = now().toISOString();
    transition(incident, 'active', status, 'DIAGNOSTIC_SLOT_CLOSED', `diagnostic task ${slot.diagnosticUserTaskId} finished as ${status}`);
    persist();
    return slot;
  }

  function canDispatch(incident) {
    return incident.dispatchCount < maxDispatchesPerIncident;
  }

  function countDispatch(incident) {
    incident.dispatchCount += 1;
    persist();
    return incident.dispatchCount;
  }

  function resolve(incidentId, { actor, reason } = {}) {
    const incident = state.incidents[incidentId];
    if (!incident) return null;
    if (incident.state === 'resolved') return { incident, transition: 'deduped' };
    incident.state = 'resolved';
    incident.resolvedAt = now().toISOString();
    if (incident.diagnosticSlot && incident.diagnosticSlot.status === 'active') {
      closeDiagnosticSlot(incident, 'completed');
    }
    transition(incident, 'open', 'resolved', 'INCIDENT_RESOLVED', `resolved by ${actor || 'unknown'}: ${reason || 'no reason given'}`);
    persist();
    return { incident, transition: 'reopened' };
  }

  function get(incidentId) {
    return state.incidents[incidentId] || null;
  }

  function list() {
    return Object.values(state.incidents);
  }

  function activeCount() {
    return list().filter(incident => incident.state === 'open').length;
  }

  /**
   * Retention: архивируем только завершённые инциденты старше TTL. Активные
   * инциденты и курсоры не стираются (AC-18).
   */
  function cleanup(nowDate = now()) {
    let archived = 0;
    for (const incident of list()) {
      if (incident.archived || incident.state !== 'resolved') continue;
      if (!isExpired(incident.resolvedAt || incident.lastSeenAt, incidentTtlMs, nowDate)) continue;
      incident.archived = true;
      incident.affectedProfileRefs = [];
      incident.affectedTaskIds = [];
      incident.affectedTaskRefs = [];
      incident.transitions = incident.transitions.slice(-3);
      incident.archiveReason = 'INCIDENT_ARCHIVED_AFTER_TTL';
      archived += 1;
    }
    if (archived > 0) persist();
    return { archived };
  }

  function summary() {
    const incidents = list();
    return {
      total: incidents.length,
      open: incidents.filter(incident => incident.state === 'open').length,
      resolved: incidents.filter(incident => incident.state === 'resolved').length,
      archived: incidents.filter(incident => incident.archived).length,
      events: incidents.reduce((sum, incident) => sum + incident.count, 0),
      suppressed: incidents.reduce((sum, incident) => sum + incident.suppressedCount, 0),
      activeDiagnosticSlots: incidents.filter(incident => incident.diagnosticSlot && incident.diagnosticSlot.status === 'active').length,
    };
  }

  return {
    ingest,
    recordSuppressed,
    openDiagnosticSlot,
    appendToDiagnosticSlot,
    closeDiagnosticSlot,
    canDispatch,
    countDispatch,
    resolve,
    get,
    list,
    activeCount,
    cleanup,
    summary,
    incidentIdFor,
    transitions: () => readLines(transitionsFile),
  };
}

module.exports = {
  createIncidentStore,
  incidentIdFor,
  diagnosticTaskIdFor,
  SEVERITY_RANK,
  INCIDENT_STATES,
  SLOT_STATUSES,
};
