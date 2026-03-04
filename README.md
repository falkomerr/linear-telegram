# Telegram + Whisper + Codex для создания задач в Linear

## Что делает

- Принимает сообщения в Telegram (текст и voice).
- Поддерживает несколько командных инстансов в одном процессе (`instances`).
- Проект задается в начале сообщения: `[PROJECT] Текст задачи`.
- Распознает голос через Whisper (OpenAI).
- Формирует задачу через Codex-compatible API.
- Создает задачу в Linear.

## Структура

- `src/` — исходный код TypeScript.
- `config/` — пример конфигурации инстансов (`instances.example.json`).
- `deploy/` — пример `docker-compose` для запуска контейнера.
- `Dockerfile` — минимальный образ сборки и запуска.
- `.env.example` — шаблон переменных окружения.

## Быстрый старт локально

1. Установить зависимости

```bash
bun install
```

2. Скопировать конфигурационный файл и `.env`:

```bash
cp config/instances.example.json config/instances.json
cp .env.example .env
```

3. Отредактировать `config/instances.json` и `.env` под ваши команды.

4. Запустить в dev-режиме:

```bash
bun run dev
```

или production-сборка:

```bash
bun run build
bun run start
```

## Конфигурация окружения

В `.env` нужны ключи:

- `OPENAI_API_KEY` или `CODEX_API_KEY` (для генерации/анализа задач)
- `LINEAR_API_URL`, если нужна кастомная точка доступа (по умолчанию `https://api.linear.app/graphql`)
- `CONFIG_PATH` — путь к `config/instances.json` (по умолчанию `./config/instances.json`)

Дополнительные переменные:

- `CODEX_API_URL`
- `CODEX_MODEL` (по умолчанию `gpt-4o-mini`)
- `WHISPER_PROVIDER`, `WHISPER_MODEL`
- `QUEUE_CONCURRENCY`, `POLLING`, `LOG_LEVEL`, `REQUEST_DEDUP_TTL_MS`

## Пример запуска двух Telegram-инстансов

`linear-telegram` поддерживает мульти-инстанс в одном процессе. Для двух команд добавьте два блока в `instances`:

```json
{
  "instances": [
    {
      "id": "smartfish",
      "name": "SmartFish",
      "telegramToken": "8687978902:AAE...",
      "linearApiToken": "lin_api_xxx",
      "linearTeamId": "<SMARTFISH_LINEAR_TEAM_ID>",
      "routePolicy": "explicit-or-last",
      "projects": []
    },
    {
      "id": "millpay",
      "name": "MillPay",
      "telegramToken": "8767913261:AAE...",
      "linearApiToken": "lin_api_xxx",
      "linearTeamId": "<MILLPAY_LINEAR_TEAM_ID>",
      "routePolicy": "explicit-or-last",
      "projects": []
    }
  ]
}
```

Если хотите запускать отдельные процессы на разные `.env`, создайте два env-файла с разными `INSTANCES_JSON`/`CONFIG_PATH` и запускайте два `bun run dev`/`bun run start`.

## Примечание по безопасности

- `linear`/`telegram`/`openai`/`codex` токены **никогда не хранятся в репозитории**.
- В репозиторий должны попадать только шаблоны (`.env.example`, примеры `instances.json`, исходный код).

## Ограничения MVP

- Логика редактирования подтверждения (`edit`) базовая.
- Кнопки Telegram в этом билде не используются.
