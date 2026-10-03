'use strict';

// Quarantine для событий с нарушением контракта (C12): отсутствующий профиль у
// profile-scope, незарегистрированный источник, неполный replyContext. Событие
// не выбрасывается и не уходит случайному пользователю: оно ждёт ops
// reconciliation. В журнал — только safeSummary и privateDetailsRef.

const crypto = require('crypto');
const path = require('path');
const { appendLine, readState, writeState, readLines } = require('./jsonl');
const { isExpired } = require('./retention');

const ITEMS_FILE = 'reconciliation.jsonl';
const STATE_FILE = 'reconciliation-state.json';
const ITEM_STATUSES = ['open', 'resolved'];
const ITEM_TTL_MS = 30 * 24 * 60 * 60 * 1000;

function reconciliationIdFor(eventId, occurredAt) {
  return `REC_${crypto.createHash('sha256').update(`${eventId || 'unknown'}:${occurredAt}`).digest('hex').slice(0, 24)}`;
}

/**
 * @param {object} options
 * @param {string} options.root изолированный корень watcher'а
 * @param {object} [options.log]
 * @param {() => Date} [options.now]
 */
function createReconciliationStore({ root, log, now = () => new Date() } = {}) {
  if (!root) throw new Error('reconciliation store requires an isolated root');
  const itemsFile = path.join(root, ITEMS_FILE);
  const stateFile = path.join(root, STATE_FILE);

  let state = readState(stateFile, { items: {} });
  if (!state || typeof state !== 'object' || !state.items) state = { items: {} };

  function persist() {
    writeState(stateFile, state);
  }

  function quarantine({ event, violations, reasonCode }) {
    const occurredAt = event && event.occurredAt ? event.occurredAt : now().toISOString();
    const eventId = event && event.eventId ? event.eventId : null;
    const item = {
      reconciliationId: reconciliationIdFor(eventId, occurredAt),
      eventId,
      violations: Array.isArray(violations) ? violations.slice() : [],
      reasonCode: reasonCode || 'CONTRACT_VIOLATION',
      status: 'open',
      occurredAt,
      safeSummary: event && event.error && event.error.safeSummary ? event.error.safeSummary : null,
      privateDetailsRef: event && event.error && event.error.privateDetailsRef ? event.error.privateDetailsRef : null,
      event: event || null,
      resolvedAt: null,
      resolvedBy: null,
      resolution: null,
    };
    state.items[item.reconciliationId] = item;
    appendLine(itemsFile, {
      at: occurredAt,
      reconciliationId: item.reconciliationId,
      eventId,
      from: 'received',
      to: 'quarantined',
      reasonCode: item.reasonCode,
      detail: `contract violation ${item.violations.join(',') || 'unknown'}; no user delivery, no diagnosis`,
      violations: item.violations,
      safeSummary: item.safeSummary,
      privateDetailsRef: item.privateDetailsRef,
    });
    log?.write('reconciliation.quarantined', {
      reconciliationId: item.reconciliationId,
      eventId,
      from: 'received',
      to: 'quarantined',
      reasonCode: item.reasonCode,
      detail: 'the event waits for ops reconciliation; it is never delivered to a guessed user',
      violations: item.violations,
      safeSummary: item.safeSummary,
      privateDetailsRef: item.privateDetailsRef,
    });
    persist();
    return item;
  }

  function resolve(reconciliationId, { actor, reason } = {}) {
    const item = state.items[reconciliationId];
    if (!item) return null;
    if (item.status === 'resolved') return { item, transition: 'deduped' };
    item.status = 'resolved';
    item.resolvedAt = now().toISOString();
    item.resolvedBy = actor || 'unknown';
    item.resolution = reason || 'no reason given';
    appendLine(itemsFile, {
      at: item.resolvedAt,
      reconciliationId: item.reconciliationId,
      from: 'quarantined',
      to: 'resolved',
      reasonCode: 'RECONCILIATION_RESOLVED',
      detail: `resolved by ${item.resolvedBy}: ${item.resolution}`,
      actor: item.resolvedBy,
      reason: item.resolution,
    });
    persist();
    return { item, transition: 'resolved' };
  }

  function get(reconciliationId) {
    return state.items[reconciliationId] || null;
  }

  function list() {
    return Object.values(state.items);
  }

  function openCount() {
    return list().filter(item => item.status === 'open').length;
  }

  function cleanup(nowDate = now()) {
    let expired = 0;
    for (const item of list()) {
      if (item.status === 'resolved' && !item.archived && isExpired(item.resolvedAt, ITEM_TTL_MS, nowDate)) {
        item.archived = true;
        item.event = null;
        expired += 1;
      }
    }
    if (expired > 0) persist();
    return { expired };
  }

  return {
    quarantine,
    resolve,
    get,
    list,
    openCount,
    cleanup,
    entries: () => readLines(itemsFile),
  };
}

module.exports = { createReconciliationStore };
