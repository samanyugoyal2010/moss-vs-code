# Moss Discord bot

This example turns a Discord server into a small semantic knowledge base. A moderator can add knowledge with `!moss-index <text>`, and anyone can search it with `!ask <question>`. Each indexed item keeps the author, channel, and jump URL as Moss metadata.

## Setup

Create a Discord application and bot, enable the **Message Content Intent**, and invite it with the `Send Messages` and `Read Messages` permissions. Copy the environment template and fill in the four values:

```bash
cd apps/discord-bot
cp env.example .env
uv sync --dev
uv run python bot.py
```

The Moss project credentials are read only from environment variables. The configured index is created on the first `!moss-index` command and subsequent entries are appended with `add_docs`.

## Commands

- `!moss-index <text>` — moderator-only; create or append a knowledge item.
- `!ask <question>` — return the three most relevant Moss results.

For production use, add rate limiting and choose a privacy policy for messages before indexing them.
