'use strict';

// Suppression-правила: timed mute и permanent ignore, всегда scoped и всегда с
// причиной и автором. Wildcard на всю платформу запрещён (AC-273): правило
// обязано фиксировать точный fingerprint и хотя бы одну границу scope.
// Permanent ignore живёт до revoke и остаётся в аудите.

const crypto = require('crypto');
const path = require('path');
const { appendLine, readState, writeState } = require('./jsonl');
const { isExpired } = require('./retention');

const RULES_FILE = 'suppression.jsonl';
const STATE_FILE = 'suppression-state.json';
const RULE_KINDS = ['mute_until', 'ignore_until_revoked'];
const SCOPE_KINDS = ['profile', 'platform'];
const FINGERPRINT_PATTERN = /^[0-9a-f]{64}$/;

function suppressionIdFor({ fingerprint, scope, kind, createdAt }) {
  const key = [fingerprint, scope.kind, scope.tenantId || '-', scope.profileId || '-', scope.sourceId || '-', kind, createdAt].join('::');
  return `SUP_${crypto.createHash('sha256').update(key).digest('hex').slice(0, 24)}`;
}

function scopeKey(scope) {
  return [scope.kind, scope.tenantId || '-', scope.profileId || '-', scope.sourceId || '-'].join('::');
}

function isRuleActive(rule, now) {
  return !rule.revokedAt && !rule.expiredAt && !(rule.expiresAt && Date.parse(rule.expiresAt) <= Date.parse(now.toISOString()));
}

function scopeMatches(ruleScope, scope) {
  if (ruleScope.kind !== scope.kind) return false;
  if (ruleScope.tenantId && ruleScope.tenantId !== scope.tenantId) return false;
  if (ruleScope.profileId && ruleScope.profileId !== scope.profileId) return false;
  if (ruleScope.sourceId && ruleScope.sourceId !== scope.sourceId) return false;
  return true;
}

/**
 * @param {object} options
 * @param {string} options.root изолированный корень watcher'а
 * @param {object} [options.log]
 * @param {() => Date} [options.now]
 * @param {object} [options.config]
 */
function createSuppressionStore({ root, log, now = () => new Date(), config = {} } = {}) {
  if (!root) throw new Error('suppression store requires an isolated root');
  const rulesFile = path.join(root, RULES_FILE);
  const stateFile = path.join(root, STATE_FILE);
  const ruleTtlMs = Number.isFinite(config.suppressionRuleTtlMs) ? config.suppressionRuleTtlMs : 90 * 24 * 60 * 60 * 1000;

  let state = readState(stateFile, { rules: {} });
  if (!state || typeof state !== 'object' || !state.rules) state = { rules: {} };

  function persist() {
    writeState(stateFile, state);
  }

  function audit(entry) {
    appendLine(rulesFile, entry);
  }

  function create({ kind, fingerprint, scope, reason, actor, expiresAt = null }) {
    if (!RULE_KINDS.includes(kind)) throw new Error(`unknown suppression kind "${kind}"`);
    if (!FINGERPRINT_PATTERN.test(String(fingerprint || ''))) {
      throw new Error('suppression requires an exact fingerprint; a wildcard rule is forbidden');
    }
    const normalizedScope = {
      kind: SCOPE_KINDS.includes(scope && scope.kind) ? scope.kind : null,
      tenantId: scope && scope.tenantId ? scope.tenantId : null,
      profileId: scope && scope.profileId ? scope.profileId : null,
      sourceId: scope && scope.sourceId ? scope.sourceId : null,
    };
    if (!normalizedScope.kind) throw new Error('suppression requires a scope kind');
    if (!normalizedScope.tenantId && !normalizedScope.profileId && !normalizedScope.sourceId) {
      throw new Error('suppression scope is too wide: pin at least one of tenantId, profileId or sourceId');
    }
    if (typeof reason !== 'string' || reason.trim().length < 8) {
      throw new Error('suppression requires a reason of at least 8 characters');
    }
    if (typeof actor !== 'string' || actor.trim().length === 0) {
      throw new Error('suppression requires an actor');
    }
    if (kind === 'mute_until') {
      if (!expiresAt || !Number.isFinite(Date.parse(expiresAt))) throw new Error('a timed mute requires expiresAt');
      if (Date.parse(expiresAt) <= Date.parse(now().toISOString())) throw new Error('a timed mute cannot expire in the past');
    }

    const createdAt = now().toISOString();
    const rule = {
      suppressionId: suppressionIdFor({ fingerprint, scope: normalizedScope, kind, createdAt }),
      kind,
      fingerprint,
      scope: normalizedScope,
      reason: reason.trim(),
      actor: actor.trim(),
      createdAt,
      expiresAt: kind === 'mute_until' ? expiresAt : null,
      revokedAt: null,
      revokedBy: null,
      revokeReason: null,
      expiredAt: null,
      matchCount: 0,
      lastMatchedAt: null,
      archived: false,
    };
    state.rules[rule.suppressionId] = rule;
    audit({
      at: createdAt,
      suppressionId: rule.suppressionId,
      from: 'none',
      to: 'created',
      reasonCode: kind === 'mute_until' ? 'SUPPRESSION_MUTE_CREATED' : 'SUPPRESSION_IGNORE_CREATED',
      detail: `${kind} on fingerprint ${fingerprint.slice(0, 12)}… scope ${scopeKey(normalizedScope)} by ${rule.actor}: ${rule.reason}`,
      kind,
      fingerprint,
      scope: normalizedScope,
      expiresAt: rule.expiresAt,
      actor: rule.actor,
      reason: rule.reason,
    });
    persist();
    return rule;
  }

  function revoke(suppressionId, { actor, reason } = {}) {
    const rule = state.rules[suppressionId];
    if (!rule) return null;
    if (rule.revokedAt) return { rule, transition: 'deduped' };
    rule.revokedAt = now().toISOString();
    rule.revokedBy = actor || 'unknown';
    rule.revokeReason = reason || 'no reason given';
    audit({
      at: rule.revokedAt,
      suppressionId: rule.suppressionId,
      from: 'active',
      to: 'revoked',
      reasonCode: 'SUPPRESSION_REVOKED',
      detail: `revoked by ${rule.revokedBy}: ${rule.revokeReason}`,
      actor: rule.revokedBy,
      reason: rule.revokeReason,
    });
    persist();
    return { rule, transition: 'revoked' };
  }

  /**
   * Активное правило для этого fingerprint и scope. Просроченные правила не
   * матчатся и одинчасно помечаются expiredAt — именно это переоткрывает инцидент
   * для диагностики (reopen по expiry).
   */
  function match(fingerprint, scope, nowDate = now()) {
    const stamp = nowDate.toISOString();
    let matched = null;
    const expired = [];
    for (const rule of Object.values(state.rules)) {
      if (rule.fingerprint !== fingerprint) continue;
      if (rule.revokedAt) continue;
      if (rule.expiresAt && Date.parse(rule.expiresAt) <= Date.parse(stamp)) {
        if (!rule.expiredAt) {
          rule.expiredAt = stamp;
          expired.push(rule);
          audit({
            at: stamp,
            suppressionId: rule.suppressionId,
            from: 'active',
            to: 'expired',
            reasonCode: 'SUPPRESSION_EXPIRED',
            detail: `mute_until reached ${rule.expiresAt}; the incident is eligible for reopen`,
            expiresAt: rule.expiresAt,
          });
        }
        continue;
      }
      if (!scopeMatches(rule.scope, scope)) continue;
      rule.matchCount += 1;
      rule.lastMatchedAt = stamp;
      matched = rule;
    }
    if (matched || expired.length > 0) persist();
    if (matched) {
      log?.write('suppression.matched', {
        suppressionId: matched.suppressionId,
        incidentId: null,
        from: 'active',
        to: 'matched',
        reasonCode: 'SUPPRESSION_MATCHED',
        detail: `${matched.kind} applied; no diagnosis and no delivery for this event`,
        fingerprint,
        scope: scopeKey(scope),
        matchCount: matched.matchCount,
      });
    }
    return matched ? { rule: matched, expired } : { rule: null, expired };
  }

  function list() {
    return Object.values(state.rules);
  }

  function auditEntries() {
    return readLines(rulesFile);
  }

  function cleanup(nowDate = now()) {
    let expired = 0;
    let archived = 0;
    for (const rule of Object.values(state.rules)) {
      if (!rule.expiredAt && rule.expiresAt && Date.parse(rule.expiresAt) <= Date.parse(nowDate.toISOString())) {
        rule.expiredAt = nowDate.toISOString();
        expired += 1;
      }
      if (!rule.archived && (rule.revokedAt || rule.expiredAt) && isExpired(rule.revokedAt || rule.expiredAt, ruleTtlMs, nowDate)) {
        rule.archived = true;
        archived += 1;
      }
    }
    if (expired > 0 || archived > 0) persist();
    return { expired, archived };
  }

  return {
    create,
    revoke,
    match,
    list,
    auditEntries,
    cleanup,
    isActive: isRuleActive,
  };
}

module.exports = {
  createSuppressionStore,
  suppressionIdFor,
  scopeKey,
  isRuleActive,
  RULE_KINDS,
};
