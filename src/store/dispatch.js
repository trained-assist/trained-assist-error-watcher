'use strict';

// Журнал dispatch-интентов диагностики и их квитанций. Здесь считается бюджет
// вызовов: шторм событий не превращается в шторм вызовов LLM/OpenCode — на один
// инцидент не более одной активной diagnostic Task и не более
// maxDispatchesPerIncident попыток, плюс глобальное окно бюджета. Избыток
// виден в backlog, а не теряется молча.

const crypto = require('crypto');
const path = require('path');
const { appendLine, readState, writeState } = require('./jsonl');

const INTENTS_FILE = 'dispatch.jsonl';
const STATE_FILE = 'dispatch-state.json';
const INTENT_STATUSES = ['pending', 'submitted', 'failed'];

function dispatchIdFor(incidentId, diagnosticUserTaskId) {
  return `DSP_${crypto.createHash('sha256').update(`${incidentId}:${diagnosticUserTaskId}`).digest('hex').slice(0, 24)}`;
}

/**
 * @param {object} options
 * @param {string} options.root изолированный корень watcher'а
 * @param {object} [options.log]
 * @param {() => Date} [options.now]
 * @param {object} [options.config]
 */
function createDispatchLedger({ root, log, now = () => new Date(), config = {} } = {}) {
  if (!root) throw new Error('dispatch ledger requires an isolated root');
  const intentsFile = path.join(root, INTENTS_FILE);
  const stateFile = path.join(root, STATE_FILE);

  const windowMs = Number.isFinite(config.dispatchWindowMs) ? config.dispatchWindowMs : 60 * 60 * 1000;
  const globalBudget = Number.isInteger(config.globalDispatchBudgetPerWindow) ? config.globalDispatchBudgetPerWindow : 10;

  let state = readState(stateFile, { intents: {} });
  if (!state || typeof state !== 'object' || !state.intents) state = { intents: {} };

  function persist() {
    writeState(stateFile, state);
  }

  function intentsInWindow(nowDate) {
    const stamp = Date.parse(nowDate.toISOString());
    return Object.values(state.intents).filter(intent => stamp - Date.parse(intent.createdAt) < windowMs).length;
  }

  function canDispatch(nowDate = now()) {
    return intentsInWindow(nowDate) < globalBudget;
  }

  function record({ incidentId, diagnosticUserTaskId, fingerprint, reasonCode, eventIds = [] }) {
    const intent = {
      dispatchId: dispatchIdFor(incidentId, diagnosticUserTaskId),
      incidentId,
      diagnosticUserTaskId,
      fingerprint,
      reasonCode: reasonCode || 'DIAGNOSIS_DISPATCHED',
      status: 'pending',
      createdAt: now().toISOString(),
      eventIds: eventIds.slice(0, 20),
      eventCount: eventIds.length,
      receipt: null,
    };
    state.intents[intent.dispatchId] = intent;
    appendLine(intentsFile, {
      at: intent.createdAt,
      dispatchId: intent.dispatchId,
      incidentId,
      diagnosticUserTaskId,
      from: 'incident',
      to: 'dispatched',
      reasonCode: intent.reasonCode,
      detail: 'one bounded dispatch intent for the incident; the storm does not multiply dispatches',
      fingerprint,
      eventCount: intent.eventCount,
    });
    persist();
    return intent;
  }

  function receipt(dispatchId, { status, detail } = {}) {
    const intent = state.intents[dispatchId];
    if (!intent) return null;
    if (!INTENT_STATUSES.includes(status)) throw new Error(`unknown dispatch status "${status}"`);
    intent.status = status;
    intent.receipt = { at: now().toISOString(), status, detail: detail || null };
    appendLine(intentsFile, {
      at: intent.receipt.at,
      dispatchId: intent.dispatchId,
      incidentId: intent.incidentId,
      from: 'dispatched',
      to: status,
      reasonCode: status === 'submitted' ? 'DIAGNOSIS_SUBMITTED' : 'DIAGNOSIS_FAILED',
      detail: intent.receipt.detail,
    });
    persist();
    return intent;
  }

  function list() {
    return Object.values(state.intents);
  }

  function backlog() {
    return list().filter(intent => intent.status === 'pending');
  }

  function counts() {
    const intents = list();
    return {
      intents: intents.length,
      pending: intents.filter(intent => intent.status === 'pending').length,
      submitted: intents.filter(intent => intent.status === 'submitted').length,
      failed: intents.filter(intent => intent.status === 'failed').length,
      windowBudget: globalBudget,
      windowMs,
      usedInWindow: intentsInWindow(now()),
    };
  }

  return {
    record,
    receipt,
    list,
    backlog,
    counts,
    canDispatch,
    entries: () => readLines(intentsFile),
  };
}

module.exports = { createDispatchLedger, dispatchIdFor, INTENT_STATUSES };
