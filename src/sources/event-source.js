'use strict';

// Durable журнал событий источника (producer side). Watcher читает этот журнал
// через reader с cursor/replay/dedup и никогда его не удаляет: исходные ошибки
// сохраняются, suppression работает по fingerprint, а не удалением исходников.

const fs = require('fs');
const path = require('path');

const EVENTS_FILE = 'events.jsonl';

function appendLine(file, line) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.appendFileSync(file, `${JSON.stringify(line)}\n`, { mode: 0o600 });
}

function readLines(file) {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8')
    .split('\n')
    .filter(line => line.trim().length > 0)
    .map(line => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

/**
 * @param {object} options
 * @param {string} options.root изолированный корень источника
 * @param {string} options.sourceId
 * @param {() => Date} [options.now]
 */
function createEventSource({ root, sourceId, now = () => new Date() } = {}) {
  if (!root) throw new Error('event source requires an isolated root');
  if (!sourceId) throw new Error('event source requires a sourceId');
  const dir = path.join(root, 'sources', sourceId);
  const file = path.join(dir, EVENTS_FILE);

  function append(event) {
    const entry = {
      schemaVersion: 1,
      receivedAt: now().toISOString(),
      event,
    };
    appendLine(file, entry);
    return entry;
  }

  return {
    sourceId,
    root: dir,
    file,
    append,
    entries: () => readLines(file),
    truncate: () => {
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      fs.writeFileSync(file, '', { mode: 0o600 });
    },
    size: () => readLines(file).length,
  };
}

module.exports = { createEventSource };
