'use strict';

const http = require('http');
const { hashKey } = require('../sources/push-intake');

const READ_SCOPE = 'error:read';

function authenticate(req, keyStore) {
  const apiKey = req.headers['x-watcher-key'] || null;
  const scopes = (req.headers['x-watcher-scopes'] || '').split(',').map(s => s.trim()).filter(Boolean);
  const provided = typeof apiKey === 'string' && apiKey.length > 0 ? hashKey(apiKey) : null;
  const granted = provided && keyStore && typeof keyStore.has === 'function' && keyStore.has(provided)
    ? (typeof keyStore.scopesFor === 'function' ? keyStore.scopesFor(provided) : (typeof keyStore.get === 'function' ? keyStore.get(provided) : []))
    : [];
  const grantedScopes = Array.isArray(granted) ? granted : [];
  const hasScope = grantedScopes.includes(READ_SCOPE) || scopes.includes(READ_SCOPE);
  return { authenticated: Boolean(provided) && hasScope, reasonCode: !provided ? 'INTAKE_KEY_UNKNOWN' : 'INTAKE_SCOPE_MISSING' };
}

function sendJson(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

function listIncidents(incidents, { status, service, since } = {}) {
  let items = incidents.list();
  if (status) items = items.filter(i => i.state === status);
  if (service) items = items.filter(i => i.service === service);
  if (since) {
    const sinceMs = Date.parse(since);
    if (!Number.isNaN(sinceMs)) items = items.filter(i => Date.parse(i.lastSeenAt) >= sinceMs);
  }
  return items.map(i => ({
    incidentId: i.incidentId,
    fingerprint: i.fingerprint,
    service: i.service,
    errorClass: i.errorClass,
    operation: i.operation,
    state: i.state,
    severity: i.severity,
    count: i.count,
    suppressedCount: i.suppressedCount,
    firstSeenAt: i.firstSeenAt,
    lastSeenAt: i.lastSeenAt,
    affectedProfileCount: i.affectedProfileRefs.length,
    affectedTaskReports: i.affectedTaskReports,
    dispatchCount: i.dispatchCount,
    reopenCount: i.reopenCount,
    resolvedAt: i.resolvedAt,
    archived: i.archived,
  }));
}

function getIncident(incidents, incidentId) {
  const i = incidents.get(incidentId);
  if (!i) return null;
  return {
    incidentId: i.incidentId,
    fingerprint: i.fingerprint,
    scope: i.scope,
    service: i.service,
    errorClass: i.errorClass,
    operation: i.operation,
    codeVersion: i.codeVersion,
    state: i.state,
    severity: i.severity,
    count: i.count,
    suppressedCount: i.suppressedCount,
    firstSeenAt: i.firstSeenAt,
    lastSeenAt: i.lastSeenAt,
    affectedProfileRefs: i.affectedProfileRefs,
    affectedTaskIds: i.affectedTaskIds,
    affectedTaskRefs: i.affectedTaskRefs,
    affectedTaskReports: i.affectedTaskReports,
    affectedTaskIdsTruncated: i.affectedTaskIdsTruncated,
    diagnosticSlot: i.diagnosticSlot,
    dispatchCount: i.dispatchCount,
    reopenCount: i.reopenCount,
    resolvedAt: i.resolvedAt,
    archived: i.archived,
    transitions: i.transitions,
  };
}

function getSourceHealth(watcher, sourceId) {
  const entry = watcher.sources.get(sourceId);
  if (!entry) return null;
  const backlog = Math.max(0, entry.source.size() - entry.reader.cursor());
  const lastSeen = entry.spec && entry.spec.health && entry.spec.health.lastSeenAt
    ? entry.spec.health.lastSeenAt
    : null;
  const stale = lastSeen !== null && (Date.now() - Date.parse(lastSeen)) > entry.spec.health.freshnessMs;
  return {
    sourceId: entry.spec.sourceId,
    service: entry.spec.service,
    transport: entry.spec.transport,
    cursor: entry.reader.cursor(),
    delivered: entry.reader.deliveredCount(),
    backlog,
    lastSeenAt: lastSeen,
    stale,
  };
}

/**
 * @param {object} options
 * @param {object} options.watcher createErrorWatcher instance
 * @param {object} options.keyStore { has(hash), scopesFor(hash) }
 * @param {number} [options.port]
 */
function createOperationalServer({ watcher, keyStore, port = 0 } = {}) {
  if (!watcher) throw new Error('operational server requires a watcher');
  if (!keyStore) throw new Error('operational server requires a key store');

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');

    if (req.method !== 'GET') {
      sendJson(res, 405, { reasonCode: 'METHOD_NOT_ALLOWED', detail: 'operational API supports GET only' });
      return;
    }

    const auth = authenticate(req, keyStore);
    if (!auth.authenticated) {
      sendJson(res, auth.reasonCode === 'INTAKE_KEY_UNKNOWN' ? 401 : 403, {
        reasonCode: auth.reasonCode,
        detail: auth.reasonCode === 'INTAKE_KEY_UNKNOWN' ? 'unknown API key' : `missing "${READ_SCOPE}" scope`,
      });
      return;
    }

    if (url.pathname === '/health') {
      const report = watcher.health.evaluate();
      sendJson(res, 200, report);
      return;
    }

    if (url.pathname === '/incidents') {
      const status = url.searchParams.get('status') || null;
      const service = url.searchParams.get('service') || null;
      const since = url.searchParams.get('since') || null;
      const items = listIncidents(watcher.incidents, { status, service, since });
      sendJson(res, 200, { incidents: items, total: items.length });
      return;
    }

    const incidentMatch = url.pathname.match(/^\/incidents\/([^/]+)$/);
    if (incidentMatch) {
      const incidentId = incidentMatch[1];
      const incident = getIncident(watcher.incidents, incidentId);
      if (!incident) {
        sendJson(res, 404, { reasonCode: 'INCIDENT_NOT_FOUND', detail: `no incident "${incidentId}"` });
        return;
      }
      sendJson(res, 200, incident);
      return;
    }

    const sourceMatch = url.pathname.match(/^\/sources\/([^/]+)\/health$/);
    if (sourceMatch) {
      const sourceId = sourceMatch[1];
      const health = getSourceHealth(watcher, sourceId);
      if (!health) {
        sendJson(res, 404, { reasonCode: 'SOURCE_NOT_FOUND', detail: `no source "${sourceId}"` });
        return;
      }
      sendJson(res, 200, health);
      return;
    }

    sendJson(res, 404, { reasonCode: 'ROUTE_UNKNOWN', detail: `no route for ${url.pathname}` });
  });

  function start() {
    return new Promise(resolve => {
      server.listen(port, '127.0.0.1', () => resolve({ port: server.address().port }));
    });
  }

  function stop() {
    return new Promise(resolve => server.close(() => resolve()));
  }

  return { start, stop, server };
}

module.exports = { createOperationalServer };
