# Telegram Linear Bot

This repository contains a Telegram bot that creates Linear issues from text and voice messages.

The bot supports multiple team instances in one process and project routing through explicit message prefixes.

## What it does

- Accepts Telegram text and voice messages.
- Transcribes voice messages using Whisper.
- Sends normalized task payloads through a Codex-compatible service.
- Creates/updates issues in Linear.
- Supports explicit routing by project prefix.

## Repository structure

- `src/` — TypeScript source.
- `config/` — instance configuration examples.
- `deploy/` — docker-compose example.
- `Dockerfile` — build and runtime entry point.
- `.env.example` — environment template.

## Quick start

1. Install dependencies:

```bash
bun install
```

2. Copy config and env files:

```bash
cp config/instances.example.json config/instances.json
cp .env.example .env
```

3. Edit `config/instances.json` and `.env`.

4. Run in development mode:

```bash
bun run dev
```

Or run production build + start:

```bash
bun run build
bun run start
```

## Routing model

Project is resolved from message text in this order:

1. explicit prefix (`PROJECT text`), e.g. `WEB Add landing page`.
2. explicit `project:...` and `[project] ...` formats.
3. last selected project for the chat (if available).

If routing is ambiguous or missing, the bot asks for clarification.

## Environment variables

- `OPENAI_API_KEY` or `CODEX_API_KEY`
- `CODEX_API_URL`, `CODEX_MODEL`
- `LINEAR_API_TOKEN`, `LINEAR_TEAM_ID` (or fallback env defaults if configured)
- `CONFIG_PATH`, `BINDINGS_FILE`
- `QUEUE_CONCURRENCY`, `POLLING`, `POLLING_TIMEOUT`, `LOG_LEVEL`

## Security notes

- Never commit real credentials or secrets.
- Do not log user messages, tokens, or raw voice text without redaction.

## Development

```bash
bun run typecheck
bun run build
bun run dev
```

## Open source docs

- [LICENSE](LICENSE)
- [CONTRIBUTING](CONTRIBUTING.md)
- [CODE_OF_CONDUCT](CODE_OF_CONDUCT.md)
- [SECURITY](SECURITY.md)
- [CHANGELOG](CHANGELOG.md)
