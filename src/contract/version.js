'use strict';

// Версии контрактов, которые реализует этот репозиторий. Второй набор терминов
// не заводим: C12 — общий observability-контракт (registered sources → readers),
// C13 — граница watcher → Task admission. Формат записи лога повторяет P25
// (integration-gate, src/contract/events.js): log.write(event, {from,to,reasonCode,detail,...ids}).

const CONTRACT_VERSIONS = {
  C12: '1',
  C13: '1',
};

const WATCHER_CONTRACT = `C12/C13 v${CONTRACT_VERSIONS.C12}`;

const LOG_SCHEMA_VERSION = 1;

module.exports = { CONTRACT_VERSIONS, WATCHER_CONTRACT, LOG_SCHEMA_VERSION };
