# trained-assist-error-watcher

Trained Assist Error Watcher: errors to incidents, diagnosis, issue/report

Статус: создан 30.09.2026, кода пока нет.

## Что здесь будет

Чтение зарегистрированных источников ошибок, агрегация в инциденты с подавлением дублей, диагностика и выход в обход/issue/отчёт.

## Откуда берётся работа

- Границы и ownership: [ARCHITECTURE §9](https://github.com/trained-assist/trained-agent-architecture/blob/main/ARCHITECTURE.md#9-репозитории-и-ownership).
- Порядок и карточки с приёмкой: [план реализации и интеграции](https://github.com/trained-assist/trained-agent-architecture/blob/main/IMPLEMENTATION-AND-INTEGRATION-PLAN.md) — этап I09, карточки P27–P28.
- Правила разработки и песочниц: [Engineering Approach](https://github.com/trained-assist/trained-agent-architecture/blob/main/ENGINEERING-APPROACH.md), [Sandbox Plan](https://github.com/trained-assist/trained-agent-architecture/blob/main/SANDBOX-PLAN.md).

Живой сервис этим репозиторием не меняется: реализация идёт параллельно, в собственных sandbox-развёртываниях.

## Контекст репозитория

CI `Repository context` на каждый PR и main собирает карту [REPO-MAP.md](https://github.com/trained-assist/trained-assist-error-watcher/blob/repo-context/REPO-MAP.md) и сжатый пакет (I00/Z03).
