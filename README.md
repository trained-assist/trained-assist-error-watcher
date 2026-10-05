# trained-assist-error-watcher

**GCP VM exit (05.10.2026):** New work on `alesa-personal-assistent/us-central1-a/alesa-vm` is prohibited. Use serverless by default; the existing French VM only for a proven persistent or local requirement. Other Google services remain allowed. See [the exit plan](https://github.com/trained-assist/trained-agent-architecture/issues/145).


Trained Assist Error Watcher: errors to incidents, diagnosis, issue/report

Статус: P27 (агрегация инцидентов и suppression) реализован 03.10.2026 · этап I09, эпик E6 #22.

## Что здесь есть

Чтение зарегистрированных источников ошибок (cursor/replay/dedup), агрегация в инциденты по точному fingerprint, scoped timed/permanent suppression с audit и revoke, quarantine для ops reconciliation, ограниченный бюджет диагностики и независимый health alarm. Диагностика LLM→OpenCode, отчёт и issue — карточка P28.

Подробности и инварианты: [docs/ERROR-WATCHER.md](docs/ERROR-WATCHER.md).

## Проверка

```bash
npm run check            # синтаксис модулей
npm test                 # детерминированные тесты (node --test)
npm run sandbox          # сценарий этапа I09 → docs/evidence/p27-incident-aggregation/
npm run evidence:verify  # побайтовая сверка transcript
```

## Откуда берётся работа

- Границы и ownership: [ARCHITECTURE §9](https://github.com/trained-assist/trained-agent-architecture/blob/main/ARCHITECTURE.md#9-репозитории-и-ownership).
- Порядок и карточки с приёмкой: [план реализации и интеграции](https://github.com/trained-assist/trained-agent-architecture/blob/main/IMPLEMENTATION-AND-INTEGRATION-PLAN.md) — этап I09, карточки P27–P28.
- Правила разработки и песочниц: [Engineering Approach](https://github.com/trained-assist/trained-agent-architecture/blob/main/ENGINEERING-APPROACH.md), [Sandbox Plan](https://github.com/trained-assist/trained-agent-architecture/blob/main/SANDBOX-PLAN.md).

Живой сервис этим репозиторием не меняется: реализация идёт параллельно, в собственных sandbox-развёртываниях.

## Контекст репозитория

CI `Repository context` на каждый PR и main собирает карту [REPO-MAP.md](https://github.com/trained-assist/trained-assist-error-watcher/blob/repo-context/REPO-MAP.md) и сжатый пакет (I00/Z03).
