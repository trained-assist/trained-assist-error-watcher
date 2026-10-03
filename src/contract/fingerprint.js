'use strict';

// Детерминированный точный fingerprint дефекта. Bloom filter здесь не используется
// как источник решения «не рассматривать»: вероятностный фильтр способен скрыть
// новое событие, поэтому решения принимает точный store по этому digest'у.
//
// В fingerprint не входят severity и scope: изменение severity или расширение
// затронутого scope должно переоткрыть тот же инцидент, а не плодить второй.
// Профиль тоже не входит: один инцидент может затрагивать много исходных задач.

const crypto = require('crypto');

const MAX_FRAMES = 6;

function normalizeFrame(frame) {
  return String(frame)
    .replace(/\(.*?\)/g, '')
    .replace(/0x[0-9a-f]+/gi, '0xX')
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, 'UUID')
    .replace(/\b\d+\b/g, 'N')
    .replace(/[\\/]/g, '/')
    .split('/')
    .filter(part => part.length > 0)
    .slice(-2)
    .join(':')
    .trim();
}

function normalizeStackLocation(stack) {
  if (!stack) return null;
  const frames = Array.isArray(stack) ? stack : String(stack).split('\n');
  const normalized = frames
    .map(frame => normalizeFrame(frame))
    .filter(frame => frame.length > 0)
    .slice(0, MAX_FRAMES);
  return normalized.length > 0 ? normalized.join('|') : null;
}

function fingerprintParts(event) {
  const error = event && event.error ? event.error : {};
  const source = event && event.source ? event.source : {};
  return {
    service: source.service || null,
    errorClass: error.code || null,
    operation: error.operation || null,
    stackLocation: normalizeStackLocation(error.stack || error.stackTrace),
    codeVersion: error.codeVersion || source.codeVersion || null,
  };
}

function fingerprintFor(event) {
  const parts = fingerprintParts(event);
  const canonical = JSON.stringify([
    parts.service,
    parts.errorClass,
    parts.operation,
    parts.stackLocation,
    parts.codeVersion,
  ]);
  return crypto.createHash('sha256').update(canonical).digest('hex');
}

module.exports = { fingerprintFor, fingerprintParts };
