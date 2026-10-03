'use strict';

// Приём событий от внешней установки (transport http_push): ключ и scopes,
// durable receipt, dedup по eventId. Подключение watcher'а к другой установке
// идёт только через эту границу; значения ключей в код и логи не попадают.

const crypto = require('crypto');

const REQUIRED_SCOPE = 'error:write';

function hashKey(apiKey) {
  return crypto.createHash('sha256').update(String(apiKey)).digest('hex');
}

function keyStoreHas(keyStore, hash) {
  if (keyStore && typeof keyStore.has === 'function') return keyStore.has(hash);
  if (keyStore && typeof keyStore === 'object') return Object.prototype.hasOwnProperty.call(keyStore, hash);
  return false;
}

function keyStoreScopes(keyStore, hash) {
  if (keyStore && typeof keyStore.scopesFor === 'function') return keyStore.scopesFor(hash) || [];
  if (keyStore && typeof keyStore.get === 'function') return keyStore.get(hash) || [];
  if (keyStore && typeof keyStore === 'object') return keyStore[hash] || [];
  return [];
}

/**
 * @param {object} options
 * @param {string} options.root изолированный корень watcher'а
 * @param {string} options.sourceId
 * @param {object} options.source durable журнал источника (createEventSource)
 * @param {object} options.keyStore { has(hash), scopesFor(hash) }
 * @param {object} [options.log]
 * @param {() => Date} [options.now]
 */
function createPushIntake({ root, sourceId, source, keyStore, log, now = () => new Date() } = {}) {
  if (!root) throw new Error('push intake requires an isolated root');
  if (!sourceId) throw new Error('push intake requires a sourceId');
  if (!source) throw new Error('push intake requires the source durable log');
  if (!keyStore) throw new Error('push intake requires a key store');

  function receive({ apiKey, scopes, event } = {}) {
    const provided = typeof apiKey === 'string' && apiKey.length > 0 ? hashKey(apiKey) : null;
    const granted = provided && keyStoreHas(keyStore, provided) ? keyStoreScopes(keyStore, provided) : [];
    const grantedScopes = Array.isArray(granted) ? granted : [];
    const requestedScopes = Array.isArray(scopes) ? scopes : [];

    if (!provided || !keyStoreHas(keyStore, provided)) {
      log?.write('intake.auth_rejected', {
        sourceId,
        from: 'received',
        to: 'rejected',
        reasonCode: 'INTAKE_KEY_UNKNOWN',
        detail: 'the presented key is not registered for this watcher installation',
      });
      return { status: 401, receipt: null, duplicate: false, reasonCode: 'INTAKE_KEY_UNKNOWN' };
    }
    if (!grantedScopes.includes(REQUIRED_SCOPE) && !requestedScopes.includes(REQUIRED_SCOPE)) {
      log?.write('intake.scope_rejected', {
        sourceId,
        from: 'received',
        to: 'rejected',
        reasonCode: 'INTAKE_SCOPE_MISSING',
        detail: `the key is not granted the "${REQUIRED_SCOPE}" scope`,
      });
      return { status: 403, receipt: null, duplicate: false, reasonCode: 'INTAKE_SCOPE_MISSING' };
    }

    const eventId = event && typeof event === 'object' ? event.eventId : null;
    const duplicate = Boolean(eventId) && source.entries().some(entry => entry.event && entry.event.eventId === eventId);
    const receipt = {
      receiptId: `intake_${crypto.createHash('sha256').update(`${sourceId}:${eventId || now().toISOString()}`).digest('hex').slice(0, 24)}`,
      sourceId,
      eventId: eventId || null,
      receivedAt: now().toISOString(),
      duplicate,
    };

    if (duplicate) {
      log?.write('intake.duplicate_ignored', {
        sourceId,
        eventId,
        from: 'received',
        to: 'ignored',
        reasonCode: 'DUPLICATE_EVENT_IGNORED',
        detail: 'the same eventId was already accepted; no second event is stored',
      });
      return { status: 202, receipt, duplicate: true, reasonCode: 'DUPLICATE_EVENT_IGNORED' };
    }

    source.append(event);
    log?.write('intake.accepted', {
      sourceId,
      eventId,
      from: 'received',
      to: 'accepted',
      reasonCode: 'EVENT_ACCEPTED',
      detail: 'durable receipt written before the event enters the source log',
    });
    return { status: 202, receipt, duplicate: false, reasonCode: 'EVENT_ACCEPTED' };
  }

  return { sourceId, receive };
}

module.exports = { createPushIntake, hashKey };
