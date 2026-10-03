'use strict';

// Ограниченный бакет ошибок самого watcher'а (origin.kind = watcher_*). Такие
// события не агрегируются в инциденты и не порождают диагностику себя: иначе
// получился бы бесконечный цикл расследования собственного сбоя. Бакет
// ограничен размером и виден health alarm'у.

const path = require('path');
const { appendLine, readLines } = require('../store/jsonl');

const FILE = 'self-errors.jsonl';
const MAX_ENTRIES = 100;

/**
 * @param {object} options
 * @param {string} options.root изолированный корень watcher'а
 * @param {object} [options.log]
 * @param {() => Date} [options.now]
 */
function createSelfErrorBucket({ root, log, now = () => new Date() } = {}) {
  if (!root) throw new Error('self error bucket requires an isolated root');
  const file = path.join(root, FILE);

  function record(event, reasonCode) {
    const entry = {
      at: now().toISOString(),
      eventId: event ? event.eventId : null,
      origin: event ? event.origin : null,
      reasonCode: reasonCode || 'WATCHER_SELF_ERROR',
      safeSummary: event && event.error ? event.error.safeSummary : null,
      privateDetailsRef: event && event.error ? event.error.privateDetailsRef : null,
    };
    appendLine(file, entry);
    log?.write('diagnosis.self_error', {
      eventId: entry.eventId,
      from: 'watcher',
      to: 'self_error',
      reasonCode: entry.reasonCode,
      detail: 'an error of the watcher itself is recorded in a bounded bucket; it creates no incident and no diagnosis of itself',
      origin: entry.origin,
      safeSummary: entry.safeSummary,
      privateDetailsRef: entry.privateDetailsRef,
    });
    return entry;
  }

  function list() {
    return readLines(file);
  }

  function count() {
    return readLines(file).length;
  }

  function cleanup() {
    const entries = readLines(file);
    if (entries.length <= MAX_ENTRIES) return { dropped: 0 };
    const kept = entries.slice(-MAX_ENTRIES);
    const handle = path.join(root, FILE);
    const fs = require('fs');
    fs.mkdirSync(path.dirname(handle), { recursive: true, mode: 0o700 });
    fs.writeFileSync(handle, `${kept.map(entry => JSON.stringify(entry)).join('\n')}\n`, { mode: 0o600 });
    return { dropped: entries.length - kept.length };
  }

  return { record, list, count, cleanup };
}

module.exports = { createSelfErrorBucket, FILE, MAX_ENTRIES };
