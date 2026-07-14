# System Design Interview Coach

Real-time voice interview coach grounded by **Moss** sub-10ms hybrid retrieval. Voice runs fully local:

| Layer | Service | Cloud key? |
|-------|---------|------------|
| Retrieval | Moss (`system-design-rubric`) | Yes — only required cloud creds |
| LLM | Ollama `llama3` | No |
| STT | Whisper (faster-whisper) | No |
| TTS | Piper | No |
| Transport | Pipecat SmallWebRTC (P2P) | No |

## Prerequisites

- Python 3.11+
- Node.js 20+
- [Ollama](https://ollama.com) with `llama3`
- Moss project credentials from [moss.dev](https://moss.dev) / [docs.moss.dev](https://docs.moss.dev)

## Setup

### 1. Ollama

```bash
ollama pull llama3
ollama serve
```

### 2. Backend

```bash
cd apps/moss-interview-coach/backend
python -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env
# Set ONLY:
#   MOSS_PROJECT_ID=...
#   MOSS_PROJECT_KEY=...
python ingest_knowledge.py
uvicorn server:app --reload --port 8000
```

First conversation may download Whisper / Piper models. Health: `GET http://localhost:8000/health`

Re-ingest rubrics:

```bash
python ingest_knowledge.py --recreate
# or markdown: python ingest_knowledge.py --source ./knowledge/md --recreate
```

### 3. Frontend

```bash
cd apps/moss-interview-coach/frontend
cp .env.example .env.local
npm install
npm run dev
```

Open [http://localhost:3000](http://localhost:3000) → **Start Interview**.

## Environment

| Variable | Required | Default |
|----------|----------|---------|
| `MOSS_PROJECT_ID` | yes | — |
| `MOSS_PROJECT_KEY` | yes | — |
| `MOSS_INDEX_NAME` | no | `system-design-rubric` |
| `OLLAMA_BASE_URL` | no | `http://localhost:11434/v1` |
| `OLLAMA_MODEL` | no | `llama3` |
| `WHISPER_MODEL` | no | `base` |
| `WHISPER_DEVICE` | no | `auto` |
| `PIPER_VOICE` | no | `en_US-lessac-medium` |
| `NEXT_PUBLIC_BACKEND_URL` | no | `http://localhost:8000` |

## Architecture

```
Browser (SmallWebRTC)
  ↔ POST /api/offer (SDP)
  ↔ Pipecat: Silero VAD → Whisper → MossContextInjector → Ollama → Piper
  ↔ Assist panel events: current_question / user_answer / grade_result
```

Moss loads the index into the local runtime once (`load_index`), then each user turn queries in-process (&lt;10 ms) and appends **Context/Rubric Guidelines** to the LLM system prompt — the same ambient-retrieval pattern described in the [Moss Pipecat integration](https://docs.moss.dev/docs/integrations/pipecat) and [offline-first search](https://docs.moss.dev/docs/build/offline-first-search) docs.

During an active session, the **Assist** side panel shows the current coach question, a snippet of your last answer, and a silent second Ollama pass that grades the turn against the Moss rubric (score + improvement tips) without speaking through TTS.

## Key files

- [`backend/ingest_knowledge.py`](backend/ingest_knowledge.py) — create/load Moss index from JSON or markdown
- [`backend/server.py`](backend/server.py) — FastAPI + SmallWebRTC + Moss injector
- [`frontend/app/page.tsx`](frontend/app/page.tsx) — Idle / Connecting / Active HUD

## Notes

- Latency HUD and Assist panel read WebRTC data-channel JSON (`type: "latency"` / `"interruption"` / `"current_question"` / `"user_answer"` / `"grade_result"`). Until live metrics arrive, latency placeholders are shown (~150 / &lt;5 / ~200 / ~355 ms); Moss stays highlighted in green.
- Local Whisper + Piper STT/TTS latency will usually exceed cloud Deepgram/Cartesia; Moss remains the sub-10ms hop.
- Interruption / barge-in uses Pipecat VAD turn strategies.
