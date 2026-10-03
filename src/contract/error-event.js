'use strict';

// Нормализация и проверка ErrorEvent по C12 (OBSERVABILITY-AND-ERROR-CONTRACT).
// Нарушения контракта — не повод выбросить событие и не повод угадать
// пользователя: событие уходит в quarantine для ops reconciliation.

const SCOPE_KINDS = ['profile', 'platform'];
const SEVERITIES = ['error', 'warning', 'info'];
const OUTCOMES = ['failed', 'unknown', 'resolved'];
const REPLY_STATUSES = ['known', 'web_only', 'unavailable', 'not_applicable'];
const ORIGIN_KINDS = ['application', 'watcher_diagnosis', 'watcher_delivery', 'watcher_internal'];

const MAX_SAFE_SUMMARY_LENGTH = 240;

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function isIsoTimestamp(value) {
  if (!isNonEmptyString(value)) return false;
  const time = Date.parse(value);
  return Number.isFinite(time);
}

function normalizeOrigin(origin) {
  const raw = origin && typeof origin === 'object' ? origin : {};
  const kind = ORIGIN_KINDS.includes(raw.kind) ? raw.kind : 'application';
  const depth = Number.isInteger(raw.diagnosticDepth) && raw.diagnosticDepth >= 0 ? raw.diagnosticDepth : 0;
  return {
    kind,
    incidentId: isNonEmptyString(raw.incidentId) ? raw.incidentId : null,
    diagnosticDepth: depth,
  };
}

function normalizeReplyContext(replyContext) {
  if (!replyContext || typeof replyContext !== 'object') {
    return { channel: null, destinationRef: null, status: 'not_applicable' };
  }
  const channel = isNonEmptyString(replyContext.channel) ? replyContext.channel : null;
  const destinationRef = isNonEmptyString(replyContext.destinationRef) ? replyContext.destinationRef : null;
  const status = REPLY_STATUSES.includes(replyContext.status) ? replyContext.status : 'not_applicable';
  return { channel, destinationRef, status };
}

function normalizeScope(scope) {
  const raw = scope && typeof scope === 'object' ? scope : {};
  const kind = SCOPE_KINDS.includes(raw.kind) ? raw.kind : null;
  return {
    kind,
    tenantId: isNonEmptyString(raw.tenantId) ? raw.tenantId : null,
    profileId: isNonEmptyString(raw.profileId) ? raw.profileId : null,
  };
}

function normalizeCorrelation(correlation) {
  const raw = correlation && typeof correlation === 'object' ? correlation : {};
  const out = {};
  for (const key of ['userTaskId', 'jobId', 'runId', 'gtdId', 'operationId', 'traceId']) {
    if (isNonEmptyString(raw[key])) out[key] = raw[key];
  }
  return out;
}

function normalizeError(error) {
  const raw = error && typeof error === 'object' ? error : {};
  return {
    code: isNonEmptyString(raw.code) ? raw.code : null,
    operation: isNonEmptyString(raw.operation) ? raw.operation : null,
    severity: SEVERITIES.includes(raw.severity) ? raw.severity : 'error',
    retryable: Boolean(raw.retryable),
    outcome: OUTCOMES.includes(raw.outcome) ? raw.outcome : 'failed',
    safeSummary: isNonEmptyString(raw.safeSummary) ? raw.safeSummary : null,
    privateDetailsRef: isNonEmptyString(raw.privateDetailsRef) ? raw.privateDetailsRef : null,
  };
}

function normalizeSource(source) {
  const raw = source && typeof source === 'object' ? source : {};
  return {
    service: isNonEmptyString(raw.service) ? raw.service : null,
    release: isNonEmptyString(raw.release) ? raw.release : null,
    environment: isNonEmptyString(raw.environment) ? raw.environment : null,
  };
}

/**
 * @param {object} raw событие от зарегистрированного источника
 * @returns {{event: object|null, violations: string[]}}
 */
function normalizeErrorEvent(raw) {
  const violations = [];
  if (!raw || typeof raw !== 'object') {
    return { event: null, violations: ['EVENT_NOT_OBJECT'] };
  }

  if (!isNonEmptyString(raw.eventId)) violations.push('EVENT_ID_REQUIRED');
  if (!isIsoTimestamp(raw.occurredAt)) violations.push('OCCURRED_AT_INVALID');

  const source = normalizeSource(raw.source);
  if (!source.service) violations.push('SOURCE_SERVICE_REQUIRED');
  if (!source.release) violations.push('SOURCE_RELEASE_REQUIRED');
  if (!source.environment) violations.push('SOURCE_ENVIRONMENT_REQUIRED');

  const scope = normalizeScope(raw.scope);
  if (!scope.kind) {
    violations.push('SCOPE_KIND_INVALID');
  } else if (scope.kind === 'profile') {
    if (!scope.profileId) violations.push('PROFILE_REQUIRED');
    if (!scope.tenantId) violations.push('TENANT_REQUIRED');
  } else if (scope.profileId) {
    violations.push('PLATFORM_SCOPE_WITH_PROFILE');
  }

  const replyContext = normalizeReplyContext(raw.replyContext);
  if (raw.replyContext && typeof raw.replyContext === 'object' && raw.replyContext.status && !REPLY_STATUSES.includes(raw.replyContext.status)) {
    violations.push('REPLY_CONTEXT_STATUS_INVALID');
  }
  if (replyContext.status === 'known' && (!replyContext.channel || !replyContext.destinationRef)) {
    violations.push('REPLY_CONTEXT_INCOMPLETE');
  }

  const error = normalizeError(raw.error);
  if (!error.code) violations.push('ERROR_CODE_REQUIRED');
  if (!error.operation) violations.push('ERROR_OPERATION_REQUIRED');
  if (raw.error && typeof raw.error === 'object' && raw.error.severity && !SEVERITIES.includes(raw.error.severity)) {
    violations.push('ERROR_SEVERITY_INVALID');
  }
  if (raw.error && typeof raw.error === 'object' && raw.error.outcome && !OUTCOMES.includes(raw.error.outcome)) {
    violations.push('ERROR_OUTCOME_INVALID');
  }
  if (!error.safeSummary) {
    violations.push('SAFE_SUMMARY_REQUIRED');
  } else if (error.safeSummary.length > MAX_SAFE_SUMMARY_LENGTH || /[\r\n]/.test(error.safeSummary)) {
    violations.push('SAFE_SUMMARY_INVALID');
  }

  const origin = normalizeOrigin(raw.origin);
  if (raw.origin && typeof raw.origin === 'object' && raw.origin.kind && !ORIGIN_KINDS.includes(raw.origin.kind)) {
    violations.push('ORIGIN_KIND_INVALID');
  }

  if (violations.length > 0) {
    return { event: null, violations };
  }

  return {
    event: {
      schemaVersion: 1,
      eventId: raw.eventId,
      occurredAt: raw.occurredAt,
      source,
      scope,
      correlation: normalizeCorrelation(raw.correlation),
      replyContext,
      error,
      origin,
    },
    violations: [],
  };
}

/**
 * Может ли событие породить адресную пользовательскую доставку. Только
 * profile-scope с известным каналом; всё остальное — Web/task API либо
 * reconciliation, никогда случайный получатель.
 */
function allowsUserDelivery(event) {
  return Boolean(
    event
    && event.scope.kind === 'profile'
    && event.scope.profileId
    && event.replyContext.status === 'known'
    && event.replyContext.channel
    && event.replyContext.destinationRef,
  );
}

module.exports = {
  normalizeErrorEvent,
  allowsUserDelivery,
  SCOPE_KINDS,
  SEVERITIES,
  OUTCOMES,
  REPLY_STATUSES,
  ORIGIN_KINDS,
  MAX_SAFE_SUMMARY_LENGTH,
};
