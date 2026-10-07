'use strict';

const KNOWN_CLASSES = {
  intake_stuck_input: {
    match: (incident) => incident.errorClass === 'intake.stuck_input' || incident.operation === 'intake.stuck_input',
    diagnose: (incident) => ({
      class: 'intake_stuck_input',
      diagnosis: 'Input accepted but not started — task is stuck before admission',
      action: 'notify_user_with_start_button',
      confidence: 'high',
      needsLlm: false,
    }),
  },
  delivery_failed_exhausted: {
    match: (incident) => incident.errorClass === 'delivery.failed' && incident.count >= 3,
    diagnose: (incident) => ({
      class: 'delivery_failed_exhausted',
      diagnosis: 'Delivery exhausted after max retries — channel unavailable or rejected',
      action: 'mark_task_failed_notify_user',
      confidence: 'high',
      needsLlm: false,
    }),
  },
  runner_timeout: {
    match: (incident) => incident.errorClass === 'TIMEOUT',
    diagnose: (incident) => ({
      class: 'runner_timeout',
      diagnosis: 'Engine exceeded run timeout — agent took too long to complete',
      action: 'notify_user_suggest_retry',
      confidence: 'high',
      needsLlm: false,
    }),
  },
  runner_engine_crash: {
    match: (incident) => incident.errorClass === 'ENGINE_CRASH',
    diagnose: (incident) => ({
      class: 'runner_engine_crash',
      diagnosis: 'Engine process terminated by signal — possible OOM or infrastructure issue',
      action: 'notify_user_suggest_retry',
      confidence: 'high',
      needsLlm: false,
    }),
  },
  runner_engine_startup_failed: {
    match: (incident) => incident.errorClass === 'ENGINE_STARTUP_FAILED',
    diagnose: (incident) => ({
      class: 'runner_engine_startup_failed',
      diagnosis: 'Engine failed to start — check runner capacity and engine configuration',
      action: 'alert_ops_check_runner',
      confidence: 'high',
      needsLlm: false,
    }),
  },
  runner_preflight_failed: {
    match: (incident) => incident.errorClass === 'PREFLIGHT_FAILED',
    diagnose: (incident) => ({
      class: 'runner_preflight_failed',
      diagnosis: 'Preflight check failed — run spec validation or capacity issue',
      action: 'alert_ops_check_spec',
      confidence: 'high',
      needsLlm: false,
    }),
  },
  runner_worker_crash: {
    match: (incident) => incident.errorClass === 'WORKER_CRASH',
    diagnose: (incident) => ({
      class: 'runner_worker_crash',
      diagnosis: 'Worker restarted while run was active — execution outcome lost',
      action: 'alert_ops_check_worker',
      confidence: 'high',
      needsLlm: false,
    }),
  },
  runner_connection_lost: {
    match: (incident) => incident.errorClass === 'connection_lost',
    diagnose: (incident) => ({
      class: 'runner_connection_lost',
      diagnosis: 'Connection to runner lost — heartbeat delivery failed',
      action: 'notify_user_suggest_retry',
      confidence: 'high',
      needsLlm: false,
    }),
  },
  runner_export_failed: {
    match: (incident) => incident.errorClass === 'export_failed',
    diagnose: (incident) => ({
      class: 'runner_export_failed',
      diagnosis: 'Artifact export failed — storage or permission issue',
      action: 'alert_ops_check_storage',
      confidence: 'high',
      needsLlm: false,
    }),
  },
  provider_auth_expired: {
    match: (incident) => incident.errorClass === 'PROVIDER_AUTH_EXPIRED',
    diagnose: (incident) => ({
      class: 'provider_auth_expired',
      diagnosis: 'Provider authentication expired — token refresh needed',
      action: 'refresh_token_or_notify_user',
      confidence: 'high',
      needsLlm: false,
    }),
  },
  llm_schema_invalid: {
    match: (incident) => incident.errorClass === 'schema_invalid',
    diagnose: (incident) => ({
      class: 'llm_schema_invalid',
      diagnosis: 'LLM returned invalid schema — retry with schema fix or fallback',
      action: 'retry_with_schema_fix',
      confidence: 'high',
      needsLlm: false,
    }),
  },
  routing_degraded: {
    match: (incident) => incident.errorClass === 'routing.degraded',
    diagnose: (incident) => ({
      class: 'routing_degraded',
      diagnosis: 'Routing degraded — timeout, provider failure, or refused',
      action: 'show_degraded_notice',
      confidence: 'high',
      needsLlm: false,
    }),
  },
  gate_error: {
    match: (incident) => incident.errorClass === 'GATE_ERROR',
    diagnose: (incident) => ({
      class: 'gate_error',
      diagnosis: 'Integration Gate error — provider request failed',
      action: 'alert_ops_check_provider',
      confidence: 'medium',
      needsLlm: false,
    }),
  },
  callback_dispatch_failed: {
    match: (incident) => incident.errorClass === 'CALLBACK_DISPATCH_FAILED',
    diagnose: (incident) => ({
      class: 'callback_dispatch_failed',
      diagnosis: 'Callback delivery failed — provider endpoint unavailable',
      action: 'alert_ops_check_endpoint',
      confidence: 'medium',
      needsLlm: false,
    }),
  },
  agent_unavailable: {
    match: (incident) => incident.errorClass === 'AGENT_UNAVAILABLE',
    diagnose: (incident) => ({
      class: 'agent_unavailable',
      diagnosis: 'Agent delegation failed — agent service unavailable',
      action: 'notify_user_suggest_retry',
      confidence: 'high',
      needsLlm: false,
    }),
  },
};

function diagnose(incident) {
  if (!incident || typeof incident !== 'object') {
    return { class: 'unknown', diagnosis: 'Invalid incident', action: 'needs_human', confidence: 'low', needsLlm: true };
  }

  for (const [name, rule] of Object.entries(KNOWN_CLASSES)) {
    try {
      if (rule.match(incident)) {
        const result = rule.diagnose(incident);
        result.ruleName = name;
        return result;
      }
    } catch {
      // continue to next rule
    }
  }

  return {
    class: 'novel',
    diagnosis: 'Unknown error pattern — no deterministic diagnosis available',
    action: 'needs_llm_diagnosis',
    confidence: 'low',
    needsLlm: true,
  };
}

function knownClasses() {
  return Object.keys(KNOWN_CLASSES);
}

module.exports = { diagnose, knownClasses, KNOWN_CLASSES };
