'use strict';

// Независимый deterministic health alarm (AC-274). Он читает только durable
// состояние (журналы источников, курсоры, инциденты, dispatch, reconciliation)
// и не зависит от собственного журнала ошибок watcher'а: подавление шума не
// может заглушить тревогу о неработающем watcher'е.

const crypto = require('crypto');

const STATUS_OK = 'ok';
const STATUS_DEGRADED = 'degraded';
const STATUS_FAILING = 'failing';

function rank(status) {
  return { [STATUS_OK]: 0, [STATUS_DEGRADED]: 1, [STATUS_FAILING]: 2 }[status] || 0;
}

/**
 * @param {object} options
 * @param {string} options.root изолированный корень watcher'а
 * @param {Array<{sourceId: string, source: object, reader: object, freshnessMs: number}>} options.sources
 * @param {object} [options.incidents]
 * @param {object} [options.dispatch]
 * @param {object} [options.reconciliation]
 * @param {object} [options.log]
 * @param {() => Date} [options.now]
 * @param {object} [options.config]
 */
function createHealthAlarm({ root, sources = [], incidents, dispatch, reconciliation, log, now = () => new Date(), config = {} } = {}) {
  if (!root) throw new Error('health alarm requires an isolated root');
  let sourceList = Array.isArray(sources) ? sources.slice() : [];

  const maxBacklog = Number.isInteger(config.maxBacklog) ? config.maxBacklog : 1000;
  const maxPendingDispatch = Number.isInteger(config.maxPendingDispatch) ? config.maxPendingDispatch : 5;
  const maxOpenIncidents = Number.isInteger(config.maxOpenIncidents) ? config.maxOpenIncidents : 50;
  const maxReconciliationAgeMs = Number.isFinite(config.maxReconciliationAgeMs) ? config.maxReconciliationAgeMs : 24 * 60 * 60 * 1000;
  const maxSelfErrors = Number.isInteger(config.maxSelfErrors) ? config.maxSelfErrors : 3;

  function evaluate() {
    const checkedAt = now().toISOString();
    const reasons = [];

    for (const entry of sourceList) {
      const backlog = Math.max(0, entry.source.size() - entry.reader.cursor());
      if (backlog > maxBacklog) {
        reasons.push({ code: 'SOURCE_BACKLOG', status: STATUS_FAILING, sourceId: entry.sourceId, detail: `${backlog} events waiting behind the cursor` });
      }
      const lastSeen = entry.health && entry.health.lastSeenAt ? Date.parse(entry.health.lastSeenAt) : null;
      const age = lastSeen === null ? 0 : Date.parse(checkedAt) - lastSeen;
      if (lastSeen !== null && age > entry.freshnessMs) {
        reasons.push({ code: 'SOURCE_STALE', status: STATUS_FAILING, sourceId: entry.sourceId, detail: `no successful poll for ${age}ms (freshness ${entry.freshnessMs}ms)` });
      }
      if (lastSeen === null && entry.source.size() > 0) {
        reasons.push({ code: 'SOURCE_NEVER_POLLED', status: STATUS_DEGRADED, sourceId: entry.sourceId, detail: 'the source has events but no successful poll yet' });
      }
    }

    if (dispatch) {
      const pending = dispatch.backlog().length;
      if (pending > maxPendingDispatch) {
        reasons.push({ code: 'DISPATCH_BACKLOG', status: STATUS_DEGRADED, detail: `${pending} dispatch intents without a receipt` });
      }
    }

    if (reconciliation) {
      const stale = reconciliation.list().filter(item => {
        if (item.status !== 'open') return false;
        return Date.parse(checkedAt) - Date.parse(item.occurredAt) > maxReconciliationAgeMs;
      }).length;
      if (stale > 0) {
        reasons.push({ code: 'RECONCILIATION_STALE', status: STATUS_DEGRADED, detail: `${stale} quarantine items wait for ops reconciliation` });
      }
    }

    if (incidents) {
      const open = incidents.activeCount();
      if (open > maxOpenIncidents) {
        reasons.push({ code: 'OPEN_INCIDENTS', status: STATUS_DEGRADED, detail: `${open} open incidents` });
      }
    }

    const status = reasons.length === 0 ? STATUS_OK : reasons.some(reason => reason.status === STATUS_FAILING) ? STATUS_FAILING : STATUS_DEGRADED;
    const alarmId = `ALM_${crypto.createHash('sha256').update(`${status}:${reasons.map(reason => reason.code).sort().join(',')}`).digest('hex').slice(0, 24)}`;
    const report = {
      alarmId,
      status,
      checkedAt,
      reasons,
      summary: {
        sources: sourceList.length,
        openIncidents: incidents ? incidents.activeCount() : 0,
        pendingDispatch: dispatch ? dispatch.backlog().length : 0,
        openReconciliation: reconciliation ? reconciliation.openCount() : 0,
      },
    };
    log?.write(status === STATUS_OK ? 'watcher.health_ok' : 'watcher.health_alarm', {
      alarmId,
      from: 'watch',
      to: status,
      reasonCode: status === STATUS_OK ? 'WATCHER_HEALTHY' : 'WATCHER_UNHEALTHY',
      detail: status === STATUS_OK ? 'deterministic health alarm reports a working watcher' : reasons.map(reason => `${reason.code} (${reason.status})`).join('; '),
      status,
      reasonCodes: reasons.map(reason => reason.code),
    });
    return report;
  }

  return {
    evaluate,
    setSources(next) {
      sourceList = Array.isArray(next) ? next.slice() : [];
    },
    sources: () => sourceList.slice(),
  };
}

module.exports = { createHealthAlarm, STATUS_OK, STATUS_DEGRADED, STATUS_FAILING };
