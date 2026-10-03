'use strict';

// Reader зарегистрированного источника (C12): cursor, replay, dedup по eventId,
// bounded batch и видимый dropped-count при переполнении/ротации журнала.
// Журнал источника не изменяется: читаем только вперёд от курсора.

const fs = require('fs');
const path = require('path');

const CURSOR_FILE = 'cursor.json';
const APPLIED_FILE = 'applied.jsonl';

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

function appendLine(file, line) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.appendFileSync(file, `${JSON.stringify(line)}\n`, { mode: 0o600 });
}

/**
 * @param {object} options
 * @param {string} options.root изолированный корень watcher'а
 * @param {string} options.sourceId
 * @param {object} options.source durable журнал источника (createEventSource)
 * @param {object} [options.log]
 * @param {() => Date} [options.now]
 * @param {number} [options.batchSize]
 */
function createSourceReader({ root, sourceId, source, log, now = () => new Date(), batchSize = 100 } = {}) {
  if (!root) throw new Error('source reader requires an isolated root');
  if (!sourceId) throw new Error('source reader requires a sourceId');
  if (!source) throw new Error('source reader requires the source durable log');
  if (!Number.isInteger(batchSize) || batchSize <= 0) throw new Error('batchSize must be a positive integer');

  const cursorFile = path.join(root, 'cursors', `${sourceId}.json`);
  const appliedFile = path.join(root, 'cursors', `${sourceId}.jsonl`);
  const applied = new Set(readLines(appliedFile).map(entry => entry.eventId).filter(Boolean));

  function loadCursor() {
    if (!fs.existsSync(cursorFile)) return 0;
    try {
      const state = JSON.parse(fs.readFileSync(cursorFile, 'utf8'));
      return Number.isInteger(state.cursor) && state.cursor >= 0 ? state.cursor : 0;
    } catch {
      return 0;
    }
  }

  let cursor = loadCursor();

  function persistCursor() {
    fs.mkdirSync(path.dirname(cursorFile), { recursive: true, mode: 0o700 });
    fs.writeFileSync(cursorFile, `${JSON.stringify({ sourceId, cursor, updatedAt: now().toISOString() })}\n`, { mode: 0o600 });
  }

  function markApplied(eventId) {
    applied.add(eventId);
    appendLine(appliedFile, { eventId, at: now().toISOString() });
  }

  /**
   * Один poll: не более batchSize новых событий. Повторные eventId считаются
   * дублями доставки и не отдаются повторно (dedup по eventId, не по содержимому).
   */
  function poll() {
    const lines = source.entries();
    let dropped = 0;
    if (lines.length < cursor) {
      dropped = cursor - lines.length;
      cursor = 0;
      log?.write('reader.source_truncated', {
        sourceId,
        from: 'polling',
        to: 'replayed',
        reasonCode: 'SOURCE_LOG_TRUNCATED',
        detail: 'the source log was rotated or truncated; the cursor restarts and the dropped count stays visible',
        droppedCount: dropped,
        cursor,
      });
    }

    const events = [];
    let duplicates = 0;
    let index = cursor;
    while (index < lines.length && events.length < batchSize) {
      const entry = lines[index];
      const eventId = entry && entry.event ? entry.event.eventId : null;
      if (!eventId || applied.has(eventId)) {
        duplicates += 1;
        index += 1;
        continue;
      }
      events.push(entry.event);
      markApplied(eventId);
      index += 1;
    }
    cursor = index;
    persistCursor();

    if (events.length > 0) {
      log?.write('reader.polled', {
        sourceId,
        from: 'source',
        to: 'watcher',
        reasonCode: 'EVENTS_DELIVERED',
        detail: 'bounded batch delivered from the source cursor',
        count: events.length,
        duplicateCount: duplicates,
        droppedCount: dropped,
        cursor,
      });
    }
    return { events, cursor, duplicates, dropped, truncated: dropped > 0 };
  }

  function resetCursor() {
    cursor = 0;
    persistCursor();
    log?.write('reader.cursor_reset', {
      sourceId,
      from: 'polling',
      to: 'replay',
      reasonCode: 'CURSOR_RESET',
      detail: 'replay from the beginning; dedup by eventId still applies',
      cursor,
    });
  }

  return {
    sourceId,
    poll,
    resetCursor,
    cursor: () => cursor,
    deliveredCount: () => applied.size,
    appliedCount: () => readLines(appliedFile).length,
  };
}

module.exports = { createSourceReader };
