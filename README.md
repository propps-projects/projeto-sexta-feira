# mcp-agentclass

MCP server that turns a Panda Video micro-course into an in-chat agentic tutor. The agent listens to the lessons (via Whisper), indexes them semantically, answers questions grounded in the actual lesson content, and renders the Panda player inline in the chat — deep-linked to the exact second that answers the question.

Built for the **VMA / Produtificação** module (13 lessons, ~1h40min), but the pipeline is generic for any Panda folder.

## What it does

- **Ingestion (run once):**
  1. Pulls lesson metadata from the Panda Video API
  2. Extracts audio directly from each lesson's HLS stream (no full video download)
  3. Transcribes via OpenAI Whisper API (`whisper-1`, verbose_json) — ~$0.006/min, ~$0.60 total for the 13-lesson course
  4. Chunks + embeds transcripts locally into a SQLite vector store

- **Runtime MCP server** exposes 5 tools to Claude / ChatGPT:
  - `list_lessons` — course overview
  - `get_lesson` — metadata + (optionally) full transcript of one lesson
  - `search_course` — semantic search across all transcripts, returns lesson + timestamp + snippet
  - `excerpt_transcript` — exact transcript between two timestamps
  - `play_lesson` — renders the Panda player **inline in the chat** via [mcp-ui](https://mcpui.dev), optionally deep-linked to a specific second

## Requirements

- Node 20+ (tested on Node 24)
- `ffmpeg` on PATH (`brew install ffmpeg`)
- An OpenAI API key (for Whisper transcription)
- ~250 MB free for audio + vectors

## Setup

```bash
npm install
cp .env.example .env
# Edit .env: set PANDA_API_KEY (and PANDA_FOLDER_ID if different from default)
```

## Ingest the course (one-time, ~30–60 min depending on hardware)

```bash
# 1) Fetch lesson metadata from Panda
npm run ingest:1-fetch

# 2) Extract 16kHz mono audio from HLS streams (~1 min/lesson)
npm run ingest:2-audio

# 3) Transcribe via OpenAI Whisper API (pt-BR, with timestamps) — ~$0.60 total
npm run ingest:3-transcribe

# 4) Chunk + embed transcripts into data/vectors.db
npm run ingest:4-index
```

Or run all four sequentially:
```bash
npm run ingest:all
```

## Run the MCP server

Two transports — pick by client:

```bash
# stdio — for Claude Desktop, Claude Code, ChatGPT Desktop, MCP Inspector
npm run server

# HTTP — for Claude.ai (browser), ChatGPT.com, anything that wants a remote URL
npm run server:http   # listens on :3333 by default (PORT env override)
```

## Connecting to Claude Desktop

Add this to `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS):

```json
{
  "mcpServers": {
    "agentclass": {
      "command": "npx",
      "args": ["tsx", "/Users/rafaelalmeidasouza/Documents/mcp-agentclass/src/server.ts"],
      "cwd": "/Users/rafaelalmeidasouza/Documents/mcp-agentclass"
    }
  }
}
```

Restart Claude Desktop. You should see `agentclass` in the MCP tools list.

> **Note on MCP UI rendering in Claude Desktop:** As of this writing, Claude Desktop accepts the MCP UI resource for `play_lesson` but does not render the embedded HTML widget inline (the in-chat video player is dropped silently — only the text fallback shows). The `text` content in our tool result includes a clickable link as fallback. To get the inline player, use Claude.ai (browser) via the HTTP transport — see below.

## Connecting to Claude.ai (browser, HTTPS connector)

Claude.ai supports MCP servers as Custom Connectors over HTTPS. Run the HTTP transport, expose it publicly (VPS or ngrok), and register the URL in Settings → Connectors.

Full step-by-step guide for a fresh VPS (Ubuntu/Debian + nginx + Let's Encrypt + systemd): **[deploy/README.md](deploy/README.md)**.

TL;DR after deploy:
1. Visit https://claude.ai/customize/connectors
2. **Add Custom Connector** → URL `https://your.domain/mcp`, Bearer token = the `MCP_AUTH_TOKEN` value from `.env`
3. Connect and use in any chat

## Connecting to ChatGPT

- **Apps SDK** (custom GPT with native widget rendering): change `playerResource` in `src/ui/player.ts` to pass `adapters: { appsSdk: { enabled: true } }` to `createUIResource`. The same HTTP server works as the backend.
- **Custom Connector** (settings → MCP): point at the same `https://your.domain/mcp` URL with the bearer token.

## Example interactions

> **"O que esse curso ensina?"**
> → agent calls `list_lessons`, summarizes the 13 lessons

> **"Como ele explica funil de consciência?"**
> → agent calls `search_course("funil de consciência")`, finds hits in lesson 4, summarizes, then offers to `play_lesson(4, startSec=...)` to show the exact moment

> **"Me mostra a aula 8 a partir dos 5 minutos"**
> → agent calls `play_lesson(8, startSec=300)` — Panda player renders inline, already at 5:00

## Architecture

```
┌─ Ingestion pipeline (one-time) ───────────────────────────────┐
│  Panda API → ffmpeg/HLS → OpenAI Whisper API (pt, verbose)    │
│           → chunks (~600ch) → multilingual-e5-small embeddings│
│           → sqlite-vec                                        │
└───────────────────────────────────────────────────────────────┘
                              ↓
┌─ MCP server (stdio) ──────────────────────────────────────────┐
│  Tools: list_lessons, get_lesson, search_course,              │
│         excerpt_transcript, play_lesson (UI resource)         │
└───────────────────────────────────────────────────────────────┘
                              ↓
            Claude Desktop / Claude Code / ChatGPT
```

## File layout

```
data/
  lessons.json              # course metadata (committed-friendly, no PII)
  audio/                    # 16kHz mono WAVs (gitignored, ~200MB)
  transcripts/<NN>-<id>.json  # per-lesson timestamped transcripts
  vectors.db                # sqlite + sqlite-vec index (gitignored)
src/
  server.ts                 # MCP server entry
  lib/{panda,lessons,transcripts,embeddings,store}.ts
  ui/player.ts              # MCP-UI resource for the Panda embed
scripts/
  1-fetch-lessons.ts
  2-extract-audio.ts
  3-transcribe.ts
  4-index.ts
```

## Knobs to tune

- Whisper model: locked to `whisper-1` (only OpenAI ASR model that returns timestamped segments).
- Chunk size in `scripts/4-index.ts` — `CHUNK_CHAR_TARGET = 600` (~150 tokens) balances precision (small chunks = better timestamps) with context (big chunks = better retrieval).
- Number of hits in `search_course` — default 5; raise to 10 for broader recall.
- Want fully local instead? Swap the transcribe script back to `nodejs-whisper` (needs `brew install cmake` + a one-time whisper.cpp build).

## Known gaps / next steps

- **Smartplayer integration:** Smartplayer only exposes embeds. To extend coverage there, add a `smartplayer` source in `lib/` that takes a manual list of `{ embedUrl, title }` and write a transcription path that uses the embed URL via `ffmpeg` (if the underlying stream is accessible) or a manual upload flow.
- **ChatGPT Apps SDK** adapter switch (see "Connecting to ChatGPT" above).
- **Multi-turn memory** of which lessons the student has already covered — pass via MCP resources or a small SQLite progress table.
