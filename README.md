<div align="center">

# Discord AI Bot

**Multi-provider Discord AI assistant** — one bot, several LLM providers, automatic fallback when a model hits its rate limit.

[![Status](https://img.shields.io/badge/status-active-brightgreen?style=flat-square)](#)
[![Node.js](https://img.shields.io/badge/Node.js-18%2B-339933?style=flat-square&logo=node.js&logoColor=white)](https://nodejs.org)
[![discord.js](https://img.shields.io/badge/discord.js-v14-5865F2?style=flat-square&logo=discord&logoColor=white)](https://discord.js.org)

**English** · [Bahasa Indonesia](README.id.md)

</div>

---

## About

A Discord bot built on **Discord.js v14** that puts one chat interface in front of three AI providers at once: **OpenRouter**, **Google Gemini (native)**, and **Groq**. The design goal is resilience — when one model returns `429 Too Many Requests`, the bot moves to the next model instead of dropping the conversation.

## Features

- **Cross-provider fallback.** Models are ordered by separate quota pools: Groq and Gemini first, OpenRouter last. When one hits `429`, the bot switches and the conversation keeps going.
- **Per-model cooldown.** A rate-limited model is flagged and skipped for a while instead of being retried on every message.
- **Text, image, PDF, and voice-note input.** Vision runs on Gemini, PDFs are parsed with `pdf-parse`, audio is transcribed through `fluent-ffmpeg`.
- **Last 10 messages of context** per channel.
- **10 MB** limit per uploaded file.
- **Anti-spam:** a 5-second per-user cooldown plus a banned-word filter.
- **Discord UI:** slash commands, buttons, select menus, and modals.
- **Anti-crash:** `unhandledRejection` / `uncaughtException` handlers for the Discord network errors that normally kill a bot.

## Tech Stack

| Layer | Technology |
| --- | --- |
| Runtime | Node.js 18+ |
| Library | Discord.js v14 |
| AI providers | OpenRouter, Google Generative AI, Groq |
| File extraction | `pdf-parse`, `fluent-ffmpeg` |
| Deployment | PM2 (`ecosystem.config.js`) |

## Getting Started

### 1. Clone and install

```bash
git clone https://github.com/Ilhamaji/discord-ai-bot.git
cd discord-ai-bot
npm install
```

### 2. Create `.env`

Every variable below is **required** — the bot calls `process.exit(1)` if one is missing.

```env
BOT_TOKEN=          # Discord bot token
API_KEY=            # OpenRouter API key
GOOGLE_API_KEY=     # Google AI / Gemini API key
GROQ_API_KEY=       # Groq API key
```

A complete example lives in `.env_example`.

### 3. Run

```bash
node index.js
```

### 4. Deploy to a server (optional)

```bash
./deploy.sh          # or
pm2 start ecosystem.config.js
```

## Usage

The bot accepts two command styles.

**`?` prefix**

```
?explain recursion with a simple analogy
?ask [question]        # explicit form
?reset                 # clear conversation memory
?help                  # show help
```

**Slash commands** — `/help` and the others registered on startup (`Routes.applicationCommands`).

Send an image, PDF, or voice note together with your question — the bot picks a vision or audio-capable model.

## Project Layout

```
index.js              # entrypoint: provider config, model chain, message handler
deploy.sh             # deploy script
ecosystem.config.js   # PM2 config
.env_example          # environment template
```

## Notes

The model list in `index.js` was verified against each provider directly (look for the `verified live` comments in the code). Free models share a daily quota, so the ordering intentionally puts providers with separate quotas first.

---

<div align="center">
Built by <a href="https://github.com/Ilhamaji">Ilham Aji</a>
</div>
