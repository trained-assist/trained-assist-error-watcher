'use strict';

// Retention-классы и TTL (OBSERVABILITY-AND-ERROR-CONTRACT, «TTL: предлагаемая
// стартовая политика»). Числа — предложение этапа, задаются конфигом до
// включения sink. Suppression rule живёт до expiresAt либо до revoke.

const DAY_MS = 24 * 60 * 60 * 1000;

const RETENTION_CLASSES = {
  error_event_30d: 30 * DAY_MS,
  incident_90d: 90 * DAY_MS,
  verbose_7d: 7 * DAY_MS,
};

const DEFAULT_CONFIG = {
  errorEventTtlMs: RETENTION_CLASSES.error_event_30d,
  incidentTtlMs: RETENTION_CLASSES.incident_90d,
  verboseTtlMs: RETENTION_CLASSES.verbose_7d,
  suppressionRuleTtlMs: RETENTION_CLASSES.incident_90d,
};

function ttlForClass(retentionClass, config = DEFAULT_CONFIG) {
  if (Object.prototype.hasOwnProperty.call(RETENTION_CLASSES, retentionClass)) {
    return RETENTION_CLASSES[retentionClass];
  }
  if (retentionClass === 'custom') return config.errorEventTtlMs;
  return null;
}

function isExpired(createdAt, ttlMs, now) {
  if (!Number.isFinite(ttlMs) || ttlMs <= 0) return false;
  const time = Date.parse(createdAt);
  if (!Number.isFinite(time)) return false;
  return Date.parse(now.toISOString()) - time > ttlMs;
}

module.exports = { RETENTION_CLASSES, DEFAULT_CONFIG, ttlForClass, isExpired, DAY_MS };
