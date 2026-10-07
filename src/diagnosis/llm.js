'use strict';

const crypto = require('crypto');
const { diagnose } = require('./deterministic');

const MAX_DIAGNOSIS_PER_INCIDENT = 3;
const GLOBAL_BUDGET_PER_WINDOW = 10;
const DISPATCH_WINDOW_MS = 60 * 60 * 1000;
const MAX_DIAGNOSTIC_DEPTH = 1;

function createLlmDiagnosis({ dispatchLedger, now = () => new Date(), log } = {}) {
  let budgetUsed = 0;
  let windowStart = now();

  function canDispatch(incidentId) {
    const windowElapsed = now() - windowStart;
    if (windowElapsed > DISPATCH_WINDOW_MS) {
      budgetUsed = 0;
      windowStart = now();
    }
    if (budgetUsed >= GLOBAL_BUDGET_PER_WINDOW) return false;
    if (dispatchLedger && typeof dispatchLedger.list === 'function') {
      const incidentDispatches = dispatchLedger.list().filter(intent => intent.incidentId === incidentId).length;
      if (incidentDispatches >= MAX_DIAGNOSIS_PER_INCIDENT) return false;
    }
    return true;
  }

  function recordDispatch(incidentId) {
    budgetUsed += 1;
  }

  return { canDispatch, recordDispatch, budgetUsed: () => budgetUsed };
}

function buildLlmPrompt(incident) {
  return [
    `Novel error pattern detected (class: novel, fingerprint: ${incident.fingerprint})`,
    `Service: ${incident.service || 'unknown'}`,
    `Error class: ${incident.errorClass || 'unknown'}`,
    `Operation: ${incident.operation || 'unknown'}`,
    `Severity: ${incident.severity || 'unknown'}`,
    `Count: ${incident.count || 1}`,
    `First seen: ${incident.firstSeenAt || 'unknown'}`,
    `Affected profiles: ${(incident.affectedProfileRefs || []).map((r) => r.profileId).join(', ') || 'none'}`,
    `Affected tasks: ${(incident.affectedTaskIds || []).slice(0, 5).join(', ') || 'none'}`,
    '',
    'Provide: rootCause (one sentence), workaround (actionable step), needsEscalation (boolean).',
    'Do NOT include raw logs, credentials, or PII.',
  ].join('\n');
}

function parseLlmResponse(text) {
  if (!text || typeof text !== 'string') {
    return { rootCause: 'unknown', workaround: 'manual investigation needed', confidence: 'low', needsEscalation: true };
  }
  const lines = text.split('\n');
  const rootCause = lines.find((l) => l.match(/^rootCause:/i))?.split(':').slice(1).join(':').trim() || 'unknown';
  const workaround = lines.find((l) => l.match(/^workaround:/i))?.split(':').slice(1).join(':').trim() || 'manual investigation needed';
  const needsEscalation = lines.some((l) => l.match(/^needsEscalation:\s*true/i));
  const confidence = lines.some((l) => l.match(/^confidence:\s*(high|medium)/i)) ? (lines.find((l) => l.match(/^confidence:\s*(high|medium)/i))?.split(':')[1].trim() || 'low') : 'low';
  return { rootCause, workaround, confidence, needsEscalation };
}

function createLlmDiagnosisDispatch({ watcher, llmClient, dispatchLedger, log, now = () => new Date() } = {}) {
  const lm = createLlmDiagnosis({ dispatchLedger, now, log });

  async function dispatch(incident) {
    if (!lm.canDispatch(incident.incidentId)) {
      return { dispatchId: null, reasonCode: 'LLM_BUDGET_EXHAUSTED', needsLlm: true };
    }
    if (!llmClient) {
      return { dispatchId: null, reasonCode: 'LLM_CLIENT_NOT_CONFIGURED', needsLlm: true };
    }

    const prompt = buildLlmPrompt(incident);
    const dispatchId = `llm_${crypto.createHash('sha256').update(`${incident.incidentId}:${now().toISOString()}`).digest('hex').slice(0, 24)}`;

    try {
      const response = await llmClient.generate(prompt, { maxTokens: 500, temperature: 0.3 });
      lm.recordDispatch(incident.incidentId);
      const parsed = parseLlmResponse(response);
      log?.write('diagnosis.llm_completed', {
        incidentId: incident.incidentId,
        dispatchId,
        from: 'diagnosis',
        to: 'completed',
        reasonCode: 'LLM_DIAGNOSIS_COMPLETED',
        detail: `LLM diagnosis: ${parsed.rootCause}`,
        confidence: parsed.confidence,
        needsEscalation: parsed.needsEscalation,
      });
      return { dispatchId, reasonCode: 'LLM_DIAGNOSIS_COMPLETED', diagnosis: parsed, needsLlm: false };
    } catch (err) {
      log?.write('diagnosis.llm_failed', {
        incidentId: incident.incidentId,
        dispatchId,
        from: 'diagnosis',
        to: 'failed',
        reasonCode: 'LLM_DIAGNOSIS_FAILED',
        detail: err instanceof Error ? err.message : String(err),
      });
      return { dispatchId, reasonCode: 'LLM_DIAGNOSIS_FAILED', needsLlm: true };
    }
  }

  return { dispatch, budgetUsed: lm.budgetUsed, canDispatch: lm.canDispatch };
}

module.exports = { createLlmDiagnosis, createLlmDiagnosisDispatch, buildLlmPrompt, parseLlmResponse, MAX_DIAGNOSIS_PER_INCIDENT, GLOBAL_BUDGET_PER_WINDOW, DISPATCH_WINDOW_MS, MAX_DIAGNOSTIC_DEPTH };
