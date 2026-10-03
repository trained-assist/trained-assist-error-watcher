# Error Watcher — агрегация инцидентов и suppression

Статус: реализовано для карточки P27 (этап I09, эпик E6 #22) · 03.10.2026.
Диагностика LLM→OpenCode, отчёт и issue — отдельная карточка P28.

## Что здесь реализовано

| Слой | Файлы | Обещание |
|---|---|---|
| Контракт C12/C13 | `src/contract/` | ErrorEvent envelope, валидация scope/replyContext, детерминированный точный fingerprint |
| Источники | `src/sources/` | реестр зарегистрированных источников, reader с cursor/replay/dedup, push intake с ключом и scopes |
| Хранилища | `src/store/` | инциденты (точный fingerprint-индекс, счётчики, одна активная diagnostic Task), suppression (timed/permanent scoped), reconciliation (quarantine), dispatch (бюджет вызовов) |
| Watcher | `src/watcher/` | агрегация до LLM, решения о suppression, self-loop guard, ограниченный dispatch |
| Health | `src/ops/health.js` | независимый детерминированный alarm по durable-состоянию |

## Ключевые инварианты

- **Шторм ≠ вызовы.** 1000 событий одного дефекта → один инцидент, один dispatch-интент. Бюджет: `maxDispatchesPerIncident` и глобальное окно `globalDispatchBudgetPerWindow`; избыток виден в backlog.
- **Исходные ошибки не исчезают.** Watcher читает журнал источника и никогда его не удаляет. Suppression работает по fingerprint и только копит `count`/`suppressedCount`.
- **Одна активная diagnostic Task на инцидент** (AC-270). Новые события дополняют её, второй слот не открывается.
- **Unknown profile → reconciliation.** Событие с нарушением контракта (нет профиля у profile-scope, незарегистрированный источник) уходит в quarantine и не доставляется случайному пользователю.
- **Self-loop guard.** События с `origin.kind = watcher_*` или `diagnosticDepth > maxDiagnosticDepth` попадают в ограниченный бакет и не порождают диагностику себя.
- **Wildcard-mute запрещён** (AC-273). Правило обязано фиксировать точный fingerprint и хотя бы одну границу scope; permanent ignore имеет audit и revoke.
- **Reopen** по regression (решённый инцидент получил новое событие), expiry (истёк timed mute), severity escalation.
- **Retention** (AC-18): ускоренные часы архивируют решённые инциденты старше TTL; активные инциденты и курсоры не стираются.

## Команды

```bash
npm run check            # синтаксис всех модулей
npm test                 # 44 детерминированных теста (node --test)
npm run sandbox          # сценарий этапа I09 → docs/evidence/p27-incident-aggregation/
npm run evidence:verify  # побайтовая сверка transcript с закоммиченным
```

## Границы

- LLM/OpenCode диагностика, отчёт пользователю и создание issue — P28 (`#67`). Здесь только агрегация, suppression и reconciliation.
- Production sink не подключён: транспорт — файловый журнал источника и loopback HTTP с ключом.
- Секреты в код и логи не попадают: сырые данные уходят только в `privateDetailsRef`.
- Прод и VM не используются: песочница живёт в `.sandbox/p27-<pid>/`, часы виртуальные.

## Доказательства

- Transcript прогона: `docs/evidence/p27-incident-aggregation/transcript.json` (+ `transcript.sha256`).
- Приёмка карточки: issue #66 в `trained-assist/trained-agent-architecture`.
