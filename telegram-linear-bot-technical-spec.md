# Technical Specification

## Project
A Telegram bot for creating issues in Linear with voice message support and request transformation through a Codex-compatible service.

## 1. General idea

Build a Telegram bot that accepts user text or voice messages, extracts a task, and creates an issue in the selected Linear project/workspace. The system must support multiple instances for different Linear teams.

## 2. Scope

- Included:
  - Telegram text/voice intake
  - Whisper-based transcription
  - Codex pipeline for issue payload generation
  - Issue create/update in Linear
  - Multi-instance per team with explicit project prefix routing
- Not included in v1:
  - Separate web admin UI (Telegram commands only)
  - Email/Slack/CRM imports

## 3. Requirements

- Support commands: `/start`, `/help`, `/status`, `/projects`, `/bind`, `/unlink`, `/dryrun`.
- Project must be resolved from the first token in the message in explicit mode.
- Voice messages must be transcribed before NLP processing.
- Secrets must never be stored in repository or logs.

## 4. Non-functional goals

- Text path latency target: p95 < 5 sec.
- Voice to issue target: p95 < 90 sec.
- Safe retries with backoff and dead-letter handling.
- Structured logging with correlation IDs.
