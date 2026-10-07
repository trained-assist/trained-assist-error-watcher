'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { diagnose, knownClasses, KNOWN_CLASSES } = require('../src/diagnosis/deterministic');

function makeIncident(overrides = {}) {
  return {
    incidentId: 'INC_abc123',
    fingerprint: 'fp_abc123',
    service: 'telegram-gateway',
    errorClass: overrides.errorClass || 'ENGINE_ZERO_COST',
    operation: overrides.operation || 'runAgent',
    severity: 'error',
    count: 1,
    state: 'open',
    firstSeenAt: new Date().toISOString(),
    lastSeenAt: new Date().toISOString(),
    ...overrides,
  };
}

test('knownClasses returns all known class names', () => {
  const classes = knownClasses();
  assert.ok(Array.isArray(classes));
  assert.ok(classes.length >= 15);
  assert.ok(classes.includes('intake_stuck_input'));
  assert.ok(classes.includes('delivery_failed_exhausted'));
  assert.ok(classes.includes('runner_timeout'));
  assert.ok(classes.includes('provider_auth_expired'));
  assert.ok(classes.includes('llm_schema_invalid'));
  assert.ok(classes.includes('agent_unavailable'));
});

test('intake_stuck_input matched for stuck_input error class', () => {
  const incident = makeIncident({ errorClass: 'intake.stuck_input', operation: 'intake.stuck_input' });
  const result = diagnose(incident);
  assert.equal(result.class, 'intake_stuck_input');
  assert.equal(result.action, 'notify_user_with_start_button');
  assert.equal(result.confidence, 'high');
  assert.equal(result.needsLlm, false);
  assert.ok(result.diagnosis.includes('stuck'));
});

test('delivery_failed_exhausted matched after 3 retries', () => {
  const incident = makeIncident({ errorClass: 'delivery.failed', count: 3 });
  const result = diagnose(incident);
  assert.equal(result.class, 'delivery_failed_exhausted');
  assert.equal(result.action, 'mark_task_failed_notify_user');
  assert.equal(result.confidence, 'high');
});

test('runner_timeout matched', () => {
  const incident = makeIncident({ errorClass: 'TIMEOUT' });
  const result = diagnose(incident);
  assert.equal(result.class, 'runner_timeout');
  assert.equal(result.action, 'notify_user_suggest_retry');
});

test('runner_engine_crash matched', () => {
  const incident = makeIncident({ errorClass: 'ENGINE_CRASH' });
  const result = diagnose(incident);
  assert.equal(result.class, 'runner_engine_crash');
  assert.equal(result.action, 'notify_user_suggest_retry');
});

test('runner_engine_startup_failed matched', () => {
  const incident = makeIncident({ errorClass: 'ENGINE_STARTUP_FAILED' });
  const result = diagnose(incident);
  assert.equal(result.class, 'runner_engine_startup_failed');
  assert.equal(result.action, 'alert_ops_check_runner');
});

test('runner_preflight_failed matched', () => {
  const incident = makeIncident({ errorClass: 'PREFLIGHT_FAILED' });
  const result = diagnose(incident);
  assert.equal(result.class, 'runner_preflight_failed');
  assert.equal(result.action, 'alert_ops_check_spec');
});

test('runner_worker_crash matched', () => {
  const incident = makeIncident({ errorClass: 'WORKER_CRASH' });
  const result = diagnose(incident);
  assert.equal(result.class, 'runner_worker_crash');
  assert.equal(result.action, 'alert_ops_check_worker');
});

test('runner_connection_lost matched', () => {
  const incident = makeIncident({ errorClass: 'connection_lost' });
  const result = diagnose(incident);
  assert.equal(result.class, 'runner_connection_lost');
  assert.equal(result.action, 'notify_user_suggest_retry');
});

test('runner_export_failed matched', () => {
  const incident = makeIncident({ errorClass: 'export_failed' });
  const result = diagnose(incident);
  assert.equal(result.class, 'runner_export_failed');
  assert.equal(result.action, 'alert_ops_check_storage');
});

test('provider_auth_expired matched', () => {
  const incident = makeIncident({ errorClass: 'PROVIDER_AUTH_EXPIRED' });
  const result = diagnose(incident);
  assert.equal(result.class, 'provider_auth_expired');
  assert.equal(result.action, 'refresh_token_or_notify_user');
});

test('llm_schema_invalid matched', () => {
  const incident = makeIncident({ errorClass: 'schema_invalid' });
  const result = diagnose(incident);
  assert.equal(result.class, 'llm_schema_invalid');
  assert.equal(result.action, 'retry_with_schema_fix');
});

test('routing_degraded matched', () => {
  const incident = makeIncident({ errorClass: 'routing.degraded' });
  const result = diagnose(incident);
  assert.equal(result.class, 'routing_degraded');
  assert.equal(result.action, 'show_degraded_notice');
});

test('gate_error matched', () => {
  const incident = makeIncident({ errorClass: 'GATE_ERROR' });
  const result = diagnose(incident);
  assert.equal(result.class, 'gate_error');
  assert.equal(result.action, 'alert_ops_check_provider');
  assert.equal(result.confidence, 'medium');
});

test('callback_dispatch_failed matched', () => {
  const incident = makeIncident({ errorClass: 'CALLBACK_DISPATCH_FAILED' });
  const result = diagnose(incident);
  assert.equal(result.class, 'callback_dispatch_failed');
  assert.equal(result.action, 'alert_ops_check_endpoint');
});

test('agent_unavailable matched', () => {
  const incident = makeIncident({ errorClass: 'AGENT_UNAVAILABLE' });
  const result = diagnose(incident);
  assert.equal(result.class, 'agent_unavailable');
  assert.equal(result.action, 'notify_user_suggest_retry');
});

test('unknown error class returns novel diagnosis', () => {
  const incident = makeIncident({ errorClass: 'NOVEL_ERROR_CLASS' });
  const result = diagnose(incident);
  assert.equal(result.class, 'novel');
  assert.equal(result.action, 'needs_llm_diagnosis');
  assert.equal(result.confidence, 'low');
  assert.equal(result.needsLlm, true);
});

test('null incident returns unknown diagnosis', () => {
  const result = diagnose(null);
  assert.equal(result.class, 'unknown');
  assert.equal(result.action, 'needs_human');
  assert.equal(result.confidence, 'low');
  assert.equal(result.needsLlm, true);
});

test('result includes ruleName', () => {
  const incident = makeIncident({ errorClass: 'TIMEOUT' });
  const result = diagnose(incident);
  assert.equal(result.ruleName, 'runner_timeout');
});

test('all rules have ruleName set when matched', () => {
  const classes = [
    'intake_stuck_input', 'delivery_failed_exhausted', 'runner_timeout',
    'runner_engine_crash', 'runner_engine_startup_failed', 'runner_preflight_failed',
    'runner_worker_crash', 'runner_connection_lost', 'runner_export_failed',
    'provider_auth_expired', 'llm_schema_invalid', 'routing_degraded',
    'gate_error', 'callback_dispatch_failed', 'agent_unavailable',
  ];
  for (const className of classes) {
    const rule = KNOWN_CLASSES[className];
    assert.ok(rule, `missing rule for ${className}`);
    assert.ok(rule.match.toString().includes('incident'), `rule ${className} match function should accept incident`);
    assert.ok(rule.diagnose.toString().includes('action'), `rule ${className} diagnose function should return action`);
  }
});