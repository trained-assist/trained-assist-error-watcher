'use strict';

// Реестр зарегистрированных источников ошибок (C12). Watcher читает только
// зарегистрированные источники и не парсит произвольные файлы сервисов.

const TRANSPORTS = ['jsonl', 'http_push', 'memory'];
const RETENTION_CLASSES = ['error_event_30d', 'incident_90d', 'verbose_7d', 'custom'];

function createSourceRegistry({ log, now = () => new Date() } = {}) {
  const sources = new Map();

  function register(spec) {
    if (!spec || typeof spec !== 'object') throw new Error('source spec must be an object');
    const sourceId = typeof spec.sourceId === 'string' && spec.sourceId.trim() ? spec.sourceId : null;
    if (!sourceId) throw new Error('source registration requires a sourceId');
    if (sources.has(sourceId)) throw new Error(`source "${sourceId}" is already registered`);
    if (typeof spec.service !== 'string' || !spec.service.trim()) throw new Error(`source "${sourceId}" requires a service name`);
    if (typeof spec.owner !== 'string' || !spec.owner.trim()) throw new Error(`source "${sourceId}" requires an owner`);
    if (!TRANSPORTS.includes(spec.transport)) throw new Error(`source "${sourceId}" has unsupported transport "${spec.transport}"`);
    if (!RETENTION_CLASSES.includes(spec.retentionClass)) throw new Error(`source "${sourceId}" has unknown retention class`);
    if (spec.retentionClass === 'custom' && (!Number.isFinite(spec.ttlMs) || spec.ttlMs <= 0)) {
      throw new Error(`source "${sourceId}" with a custom retention class requires ttlMs`);
    }
    if (!spec.accessPolicy || typeof spec.accessPolicy !== 'object') throw new Error(`source "${sourceId}" requires an access policy`);
    if (!Number.isFinite(spec.freshnessMs) || spec.freshnessMs <= 0) {
      throw new Error(`source "${sourceId}" requires a health freshness signal (freshnessMs)`);
    }

    const source = {
      sourceId,
      service: spec.service,
      owner: spec.owner,
      transport: spec.transport,
      schemas: {
        error: spec.schemas && spec.schemas.error ? String(spec.schemas.error) : null,
        lifecycle: spec.schemas && spec.schemas.lifecycle ? String(spec.schemas.lifecycle) : null,
      },
      scopeRules: Array.isArray(spec.scopeRules) ? spec.scopeRules.slice() : [],
      retentionClass: spec.retentionClass,
      ttlMs: spec.retentionClass === 'custom' ? spec.ttlMs : null,
      accessPolicy: {
        reader: spec.accessPolicy.reader || null,
        scopes: Array.isArray(spec.accessPolicy.scopes) ? spec.accessPolicy.scopes.slice() : [],
      },
      health: { freshnessMs: spec.freshnessMs, lastSeenAt: null },
      registeredAt: now().toISOString(),
    };
    sources.set(sourceId, source);
    log?.write('source.registered', {
      sourceId,
      service: source.service,
      transport: source.transport,
      retentionClass: source.retentionClass,
      from: 'registry',
      to: 'registered',
      reasonCode: 'SOURCE_REGISTERED',
      detail: 'registered error source with declared schemas, scope rules, retention and health signal',
    });
    return source;
  }

  function get(sourceId) {
    return sources.get(sourceId) || null;
  }

  function list() {
    return [...sources.values()];
  }

  function has(sourceId) {
    return sources.has(sourceId);
  }

  function markSeen(sourceId) {
    const source = sources.get(sourceId);
    if (source) source.health.lastSeenAt = now().toISOString();
  }

  return { register, get, list, has, markSeen };
}

module.exports = { createSourceRegistry };
