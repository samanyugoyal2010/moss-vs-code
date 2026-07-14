#!/usr/bin/env python3
"""System Design Interview Coach — FastAPI + Pipecat SmallWebRTC + Moss.

Only cloud credentials required: MOSS_PROJECT_ID / MOSS_PROJECT_KEY.
STT = local Whisper, TTS = local Piper, LLM = local Ollama.
"""

from __future__ import annotations

import asyncio
import json
import os
import re
import time
from contextlib import asynccontextmanager
from typing import Any

import httpx
from dotenv import load_dotenv
from fastapi import BackgroundTasks, FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from loguru import logger
from moss import MossClient, QueryOptions
from pydantic import BaseModel, Field
from pipecat.audio.vad.silero import SileroVADAnalyzer
from pipecat.frames.frames import (
    BotStartedSpeakingFrame,
    BotStoppedSpeakingFrame,
    Frame,
    InterruptionFrame,
    LLMContextFrame,
    LLMFullResponseEndFrame,
    LLMFullResponseStartFrame,
    LLMTextFrame,
    MetricsFrame,
    TranscriptionFrame,
    TTSSpeakFrame,
    UserStartedSpeakingFrame,
)
from pipecat.metrics.metrics import TTFBMetricsData
from pipecat.pipeline.pipeline import Pipeline
from pipecat.pipeline.worker import PipelineParams, PipelineWorker
from pipecat.processors.aggregators.llm_context import LLMContext
from pipecat.processors.aggregators.llm_response_universal import (
    LLMContextAggregatorPair,
    LLMUserAggregatorParams,
)
from pipecat.processors.frame_processor import FrameDirection, FrameProcessor
from pipecat.processors.frameworks.rtvi import RTVIServerMessageFrame
from pipecat.services.ollama.llm import OLLamaLLMService
from pipecat.services.piper.tts import PiperTTSService
from pipecat.services.whisper.stt import Model as WhisperModel
from pipecat.services.whisper.stt import WhisperSTTService
from pipecat.transports.base_transport import TransportParams
from pipecat.transports.smallwebrtc.connection import IceServer, SmallWebRTCConnection
from pipecat.transports.smallwebrtc.request_handler import (
    IceCandidate,
    SmallWebRTCPatchRequest,
    SmallWebRTCRequest,
    SmallWebRTCRequestHandler,
)
from pipecat.transports.smallwebrtc.transport import SmallWebRTCTransport
from pipecat.workers.runner import WorkerRunner

load_dotenv()

INDEX_NAME = os.getenv("MOSS_INDEX_NAME", "system-design-rubric")
OLLAMA_BASE_URL = os.getenv("OLLAMA_BASE_URL", "http://localhost:11434/v1").rstrip("/")
OLLAMA_MODEL = os.getenv("OLLAMA_MODEL", "llama3")
WHISPER_MODEL = os.getenv("WHISPER_MODEL", "base")
WHISPER_DEVICE = os.getenv("WHISPER_DEVICE", "auto")
PIPER_VOICE = os.getenv("PIPER_VOICE", "en_US-lessac-medium")

BASE_SYSTEM_PROMPT = (
    "You are an expert System Design Interview Coach conducting a live voice interview. "
    "Ask probing follow-ups, push for trade-offs, and keep answers concise enough to speak aloud. "
    "Avoid markdown, bullets, and emojis."
)

moss_client: MossClient | None = None
moss_ready = False
active_bots = 0

ICE_SERVERS = [IceServer(urls="stun:stun.l.google.com:19302")]
small_webrtc_handler = SmallWebRTCRequestHandler(ice_servers=ICE_SERVERS)


class LatencySnapshot(BaseModel):
    type: str = "latency"
    stt_ms: float | None = None
    moss_ms: float | None = None
    llm_ttft_ms: float | None = None
    total_ms: float | None = None
    interrupted: bool = False


class GradeResult(BaseModel):
    type: str = "grade_result"
    topic: str | None = None
    score: int = Field(ge=1, le=5)
    max_score: int = 5
    summary: str
    tips: list[str] = Field(default_factory=list)


class MossContextInjector(FrameProcessor):
    """Query Moss on each user turn and inject rubric context into the LLM prompt."""

    def __init__(
        self,
        client: MossClient,
        *,
        index_name: str = INDEX_NAME,
        top_k: int = 1,
        alpha: float = 0.6,
    ) -> None:
        super().__init__()
        self._client = client
        self._index_name = index_name
        self._top_k = top_k
        self._alpha = alpha
        self.last_moss_ms: float | None = None
        self.last_rubric_id: str | None = None
        self.last_rubric_text: str | None = None
        self.last_user_answer: str | None = None
        self._turn_started_at: float | None = None
        self._stt_ended_at: float | None = None

    async def process_frame(self, frame: Frame, direction: FrameDirection) -> None:
        await super().process_frame(frame, direction)

        if isinstance(frame, UserStartedSpeakingFrame):
            self._turn_started_at = time.perf_counter()
            self._stt_ended_at = None

        if isinstance(frame, TranscriptionFrame) and frame.text.strip():
            self._stt_ended_at = time.perf_counter()

        if isinstance(frame, LLMContextFrame):
            await self._inject_rubric(frame)

        await self.push_frame(frame, direction)

    async def _inject_rubric(self, frame: LLMContextFrame) -> None:
        user_text = _last_user_text(frame.context)
        if not user_text:
            return

        self.last_user_answer = user_text
        started = time.perf_counter()
        try:
            results = await self._client.query(
                self._index_name,
                user_text,
                QueryOptions(top_k=self._top_k, alpha=self._alpha),
            )
        except Exception as exc:  # noqa: BLE001
            logger.warning(f"Moss query failed: {exc}")
            return

        elapsed_ms = (time.perf_counter() - started) * 1000.0
        reported = getattr(results, "time_taken_ms", None)
        self.last_moss_ms = float(reported) if isinstance(reported, (int, float)) else elapsed_ms

        if not results.docs:
            logger.info(f"Moss returned no docs ({self.last_moss_ms:.2f} ms)")
            await self._emit_partial_latency()
            return

        top = results.docs[0]
        self.last_rubric_id = top.id
        self.last_rubric_text = top.text
        rubric_block = (
            f"Context/Rubric Guidelines:\n"
            f"Matched topic id={top.id} score={top.score:.3f}\n"
            f"{top.text}"
        )
        _upsert_system_message(frame.context, f"{BASE_SYSTEM_PROMPT}\n\n{rubric_block}")
        logger.info(
            f"Moss retrieved '{top.id}' in {self.last_moss_ms:.2f} ms "
            f"(score={top.score:.3f})"
        )
        await self._emit_partial_latency()

    async def _emit_partial_latency(self) -> None:
        stt_ms: float | None = None
        if self._turn_started_at is not None and self._stt_ended_at is not None:
            stt_ms = (self._stt_ended_at - self._turn_started_at) * 1000.0

        payload = LatencySnapshot(
            stt_ms=stt_ms,
            moss_ms=self.last_moss_ms,
        ).model_dump()
        await self.push_frame(
            RTVIServerMessageFrame(data=payload),
            FrameDirection.DOWNSTREAM,
        )


class InterviewAssistState:
    """Shared question text between the pre-LLM grader and post-LLM question emitter."""

    def __init__(self) -> None:
        self.last_question: str | None = None
        self.bot_buf: list[str] = []


class SilentAnswerGrader(FrameProcessor):
    """On each finalized user turn, emit answer text and fire-and-forget Ollama grading."""

    def __init__(
        self,
        moss_injector: MossContextInjector,
        assist_state: InterviewAssistState,
    ) -> None:
        super().__init__()
        self._moss = moss_injector
        self._state = assist_state
        self._grade_tasks: set[asyncio.Task[None]] = set()
        self._last_graded_answer: str | None = None

    async def process_frame(self, frame: Frame, direction: FrameDirection) -> None:
        await super().process_frame(frame, direction)

        # Welcome / queued speak frames enter at the pipeline head.
        if isinstance(frame, TTSSpeakFrame) and frame.text.strip():
            self._state.bot_buf.append(frame.text.strip() + " ")
            question = _extract_question("".join(self._state.bot_buf))
            if question and question != self._state.last_question:
                self._state.last_question = question
                await self._emit({"type": "current_question", "text": question})

        if isinstance(frame, LLMContextFrame):
            answer = self._moss.last_user_answer or _last_user_text(frame.context)
            if answer and answer != self._last_graded_answer:
                self._last_graded_answer = answer
                await self._emit({"type": "user_answer", "text": answer})
                await self._emit(
                    {
                        "type": "grading_started",
                        "topic": self._moss.last_rubric_id,
                    }
                )
                self._spawn_grade(
                    question=self._state.last_question or "General system design answer",
                    answer=answer,
                    rubric_id=self._moss.last_rubric_id,
                    rubric_text=self._moss.last_rubric_text,
                )

        await self.push_frame(frame, direction)

    def _spawn_grade(
        self,
        *,
        question: str,
        answer: str,
        rubric_id: str | None,
        rubric_text: str | None,
    ) -> None:
        task = asyncio.create_task(
            self._grade_and_emit(
                question=question,
                answer=answer,
                rubric_id=rubric_id,
                rubric_text=rubric_text,
            ),
            name="silent-answer-grader",
        )
        self._grade_tasks.add(task)
        task.add_done_callback(self._grade_tasks.discard)

    async def _grade_and_emit(
        self,
        *,
        question: str,
        answer: str,
        rubric_id: str | None,
        rubric_text: str | None,
    ) -> None:
        try:
            result = await _silent_grade_answer(
                question=question,
                answer=answer,
                rubric_id=rubric_id,
                rubric_text=rubric_text,
            )
            await self._emit(result.model_dump())
        except Exception as exc:  # noqa: BLE001
            logger.warning(f"Silent grader failed: {exc}")
            await self._emit(
                GradeResult(
                    topic=rubric_id,
                    score=3,
                    summary="Could not grade this turn automatically. Keep covering trade-offs.",
                    tips=[
                        "State assumptions out loud before diving into components.",
                        "Compare at least two design alternatives with trade-offs.",
                        "Call out bottlenecks and how you would scale them.",
                    ],
                ).model_dump()
            )

    async def _emit(self, payload: dict[str, Any]) -> None:
        await self.push_frame(
            RTVIServerMessageFrame(data=payload),
            FrameDirection.DOWNSTREAM,
        )


class CoachQuestionEmitter(FrameProcessor):
    """Capture coach utterance text after the LLM and emit current_question events."""

    def __init__(self, assist_state: InterviewAssistState) -> None:
        super().__init__()
        self._state = assist_state

    async def process_frame(self, frame: Frame, direction: FrameDirection) -> None:
        await super().process_frame(frame, direction)

        if isinstance(frame, LLMFullResponseStartFrame):
            self._state.bot_buf = []

        if isinstance(frame, LLMTextFrame) and frame.text:
            self._state.bot_buf.append(frame.text)

        if isinstance(frame, (LLMFullResponseEndFrame, BotStoppedSpeakingFrame)):
            question = _extract_question("".join(self._state.bot_buf))
            if question and question != self._state.last_question:
                self._state.last_question = question
                await self.push_frame(
                    RTVIServerMessageFrame(
                        data={"type": "current_question", "text": question}
                    ),
                    FrameDirection.DOWNSTREAM,
                )

        await self.push_frame(frame, direction)


class LatencyMetricsBridge(FrameProcessor):
    """Combine Moss + LLM TTFB metrics and publish interruption / HUD events."""

    def __init__(self, moss_injector: MossContextInjector) -> None:
        super().__init__()
        self._moss = moss_injector
        self._bot_speaking = False
        self._turn_user_audio_at: float | None = None
        self._last_stt_ms: float | None = None

    async def process_frame(self, frame: Frame, direction: FrameDirection) -> None:
        await super().process_frame(frame, direction)

        if isinstance(frame, UserStartedSpeakingFrame):
            self._turn_user_audio_at = time.perf_counter()
            if self._bot_speaking:
                await self._emit({"type": "interruption", "interrupted": True})

        if isinstance(frame, InterruptionFrame) and self._bot_speaking:
            await self._emit({"type": "interruption", "interrupted": True})

        if isinstance(frame, TranscriptionFrame) and self._turn_user_audio_at is not None:
            self._last_stt_ms = (time.perf_counter() - self._turn_user_audio_at) * 1000.0

        if isinstance(frame, BotStartedSpeakingFrame):
            self._bot_speaking = True

        if isinstance(frame, BotStoppedSpeakingFrame):
            self._bot_speaking = False

        if isinstance(frame, MetricsFrame):
            await self._handle_metrics(frame)

        await self.push_frame(frame, direction)

    async def _handle_metrics(self, frame: MetricsFrame) -> None:
        llm_ttft_ms: float | None = None
        for item in frame.data:
            if isinstance(item, TTFBMetricsData) and item.value is not None:
                name = (item.processor or "").lower()
                if "tts" in name:
                    continue
                llm_ttft_ms = float(item.value) * 1000.0
                break

        if llm_ttft_ms is None:
            return

        moss_ms = self._moss.last_moss_ms
        stt_ms = self._last_stt_ms
        parts = [p for p in (stt_ms, moss_ms, llm_ttft_ms) if p is not None]
        total_ms = sum(parts) if parts else None

        await self._emit(
            LatencySnapshot(
                stt_ms=stt_ms,
                moss_ms=moss_ms,
                llm_ttft_ms=llm_ttft_ms,
                total_ms=total_ms,
            ).model_dump()
        )

    async def _emit(self, payload: dict[str, Any]) -> None:
        await self.push_frame(
            RTVIServerMessageFrame(data=payload),
            FrameDirection.DOWNSTREAM,
        )


def _extract_question(coach_text: str) -> str | None:
    text = re.sub(r"\s+", " ", coach_text).strip()
    if not text:
        return None
    # Prefer the last interrogative sentence.
    parts = re.split(r"(?<=[.?!])\s+", text)
    questions = [p.strip() for p in parts if "?" in p]
    if questions:
        return questions[-1]
    # Fall back to the last sentence / clause so the panel always has something.
    return parts[-1] if parts else text


def _parse_grade_json(raw: str) -> GradeResult:
    cleaned = raw.strip()
    fence = re.search(r"```(?:json)?\s*(\{.*?\})\s*```", cleaned, re.DOTALL)
    if fence:
        cleaned = fence.group(1)
    else:
        start = cleaned.find("{")
        end = cleaned.rfind("}")
        if start >= 0 and end > start:
            cleaned = cleaned[start : end + 1]

    data = json.loads(cleaned)
    score = int(data.get("score", 3))
    score = max(1, min(5, score))
    tips_raw = data.get("tips") or []
    tips = [str(t).strip() for t in tips_raw if str(t).strip()][:4]
    return GradeResult(
        topic=str(data["topic"]) if data.get("topic") else None,
        score=score,
        summary=str(data.get("summary") or "Review the rubric points for this topic.").strip(),
        tips=tips
        or [
            "Call out concrete trade-offs.",
            "Name the bottleneck and how you scale it.",
        ],
    )


async def _silent_grade_answer(
    *,
    question: str,
    answer: str,
    rubric_id: str | None,
    rubric_text: str | None,
) -> GradeResult:
    rubric = rubric_text or "General system design grading rubric: clarity, trade-offs, scalability."
    prompt = (
        "You are a strict system design interview grader. "
        "Return ONLY valid JSON with keys: score (1-5 integer), summary (one sentence), "
        "tips (array of 2-4 short improvement strings), topic (string).\n\n"
        f"Topic id: {rubric_id or 'unknown'}\n"
        f"Rubric:\n{rubric}\n\n"
        f"Interview question:\n{question}\n\n"
        f"Candidate answer:\n{answer}\n"
    )
    async with httpx.AsyncClient(timeout=45.0) as client:
        resp = await client.post(
            f"{OLLAMA_BASE_URL}/chat/completions",
            json={
                "model": OLLAMA_MODEL,
                "temperature": 0.2,
                "messages": [
                    {"role": "system", "content": "Respond with JSON only. No markdown."},
                    {"role": "user", "content": prompt},
                ],
            },
        )
        resp.raise_for_status()
        payload = resp.json()
        content = payload["choices"][0]["message"]["content"]
    result = _parse_grade_json(content)
    if rubric_id and not result.topic:
        result.topic = rubric_id
    return result


def _last_user_text(context: LLMContext) -> str | None:
    for message in reversed(context.get_messages()):
        if not isinstance(message, dict):
            continue
        if message.get("role") != "user":
            continue
        content = message.get("content")
        if isinstance(content, str) and content.strip():
            return content.strip()
        if isinstance(content, list):
            chunks: list[str] = []
            for part in content:
                if isinstance(part, dict) and part.get("type") == "text":
                    chunks.append(str(part.get("text", "")))
                elif isinstance(part, str):
                    chunks.append(part)
            joined = " ".join(chunks).strip()
            if joined:
                return joined
    return None


def _upsert_system_message(context: LLMContext, content: str) -> None:
    messages = list(context.get_messages())
    system_msg = {"role": "system", "content": content}
    if messages and isinstance(messages[0], dict) and messages[0].get("role") == "system":
        messages[0] = system_msg
    else:
        messages.insert(0, system_msg)
    context.set_messages(messages)


def _resolve_whisper_model(name: str) -> str | WhisperModel:
    key = name.strip().lower().replace("-", "_")
    mapping = {
        "tiny": WhisperModel.TINY,
        "base": WhisperModel.BASE,
        "small": WhisperModel.SMALL,
        "medium": WhisperModel.MEDIUM,
        "large": WhisperModel.LARGE,
        "large_v3": WhisperModel.LARGE,
    }
    return mapping.get(key, name)


async def run_interview_bot(webrtc_connection: SmallWebRTCConnection) -> None:
    global active_bots
    if moss_client is None or not moss_ready:
        raise RuntimeError("Moss client is not ready. Run ingest_knowledge.py first.")

    active_bots += 1
    try:
        transport = SmallWebRTCTransport(
            webrtc_connection=webrtc_connection,
            params=TransportParams(
                audio_in_enabled=True,
                audio_out_enabled=True,
            ),
        )

        stt = WhisperSTTService(
            device=WHISPER_DEVICE,
            settings=WhisperSTTService.Settings(model=_resolve_whisper_model(WHISPER_MODEL)),
        )
        llm = OLLamaLLMService(
            base_url=OLLAMA_BASE_URL,
            settings=OLLamaLLMService.Settings(
                model=OLLAMA_MODEL,
                system_instruction=BASE_SYSTEM_PROMPT,
            ),
        )
        tts = PiperTTSService(
            settings=PiperTTSService.Settings(voice=PIPER_VOICE),
        )

        context = LLMContext(
            messages=[{"role": "system", "content": BASE_SYSTEM_PROMPT}],
        )
        user_aggregator, assistant_aggregator = LLMContextAggregatorPair(
            context,
            user_params=LLMUserAggregatorParams(vad_analyzer=SileroVADAnalyzer()),
        )

        moss_injector = MossContextInjector(moss_client, index_name=INDEX_NAME)
        assist_state = InterviewAssistState()
        silent_grader = SilentAnswerGrader(moss_injector, assist_state)
        question_emitter = CoachQuestionEmitter(assist_state)
        latency_bridge = LatencyMetricsBridge(moss_injector)

        pipeline = Pipeline(
            [
                transport.input(),
                stt,
                user_aggregator,
                moss_injector,
                silent_grader,
                llm,
                question_emitter,
                latency_bridge,
                tts,
                transport.output(),
                assistant_aggregator,
            ]
        )

        worker = PipelineWorker(
            pipeline,
            params=PipelineParams(
                enable_metrics=True,
                enable_usage_metrics=True,
            ),
        )

        @transport.event_handler("on_client_connected")
        async def on_client_connected(transport: SmallWebRTCTransport, client: Any) -> None:
            logger.info("Client connected over SmallWebRTC")
            await asyncio.sleep(0.6)
            await worker.queue_frame(
                TTSSpeakFrame(
                    "Welcome to your system design interview. "
                    "Pick a topic—WhatsApp, rate limiting, sharding, CDNs, or the CAP theorem—"
                    "and we will dive in."
                )
            )

        @transport.event_handler("on_client_disconnected")
        async def on_client_disconnected(transport: SmallWebRTCTransport, client: Any) -> None:
            logger.info("Client disconnected; ending pipeline.")
            await worker.cancel()

        runner = WorkerRunner()
        await runner.add_workers(worker)
        await runner.run()
    finally:
        active_bots = max(0, active_bots - 1)


async def ensure_moss_loaded() -> None:
    global moss_client, moss_ready
    project_id = os.getenv("MOSS_PROJECT_ID", "").strip()
    project_key = os.getenv("MOSS_PROJECT_KEY", "").strip()
    if not project_id or not project_key:
        logger.warning("Moss credentials missing; server will start but interviews will fail.")
        return

    moss_client = MossClient(project_id, project_key)
    try:
        await moss_client.load_index(INDEX_NAME)
        moss_ready = True
        logger.info(f"Moss index '{INDEX_NAME}' loaded.")
    except Exception as exc:  # noqa: BLE001
        moss_ready = False
        logger.error(
            f"Failed to load Moss index '{INDEX_NAME}': {exc}. "
            "Run `python ingest_knowledge.py` first."
        )


@asynccontextmanager
async def lifespan(app: FastAPI):
    await ensure_moss_loaded()
    yield


app = FastAPI(title="System Design Interview Coach", lifespan=lifespan)

cors_origins = [
    origin.strip()
    for origin in os.getenv("CORS_ORIGINS", "http://localhost:3000").split(",")
    if origin.strip()
]
app.add_middleware(
    CORSMiddleware,
    allow_origins=cors_origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/health")
async def health() -> dict[str, Any]:
    ollama_ok = False
    ollama_error: str | None = None
    try:
        base = OLLAMA_BASE_URL.removesuffix("/v1")
        async with httpx.AsyncClient(timeout=2.0) as client:
            resp = await client.get(f"{base}/api/tags")
            ollama_ok = resp.status_code == 200
            if not ollama_ok:
                ollama_error = f"status={resp.status_code}"
    except Exception as exc:  # noqa: BLE001
        ollama_error = str(exc)

    return {
        "ok": moss_ready and ollama_ok,
        "moss_ready": moss_ready,
        "moss_index": INDEX_NAME,
        "ollama_ok": ollama_ok,
        "ollama_model": OLLAMA_MODEL,
        "ollama_error": ollama_error,
        "active_bots": active_bots,
        "stack": {
            "stt": f"whisper:{WHISPER_MODEL}",
            "tts": f"piper:{PIPER_VOICE}",
            "transport": "smallwebrtc",
            "llm": f"ollama:{OLLAMA_MODEL}",
            "retrieval": "moss",
        },
    }


@app.post("/api/offer")
async def offer(request: Request, background_tasks: BackgroundTasks) -> dict[str, Any]:
    """WebRTC SDP offer/answer endpoint for Pipecat SmallWebRTC clients."""
    if not moss_ready or moss_client is None:
        raise HTTPException(
            status_code=503,
            detail="Moss index not loaded. Run ingest_knowledge.py and restart the server.",
        )

    body = await request.json()
    try:
        webrtc_request = SmallWebRTCRequest.from_dict(body)
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=400, detail=f"Invalid WebRTC offer: {exc}") from exc

    async def webrtc_connection_callback(connection: SmallWebRTCConnection) -> None:
        background_tasks.add_task(run_interview_bot, connection)

    answer = await small_webrtc_handler.handle_web_request(
        request=webrtc_request,
        webrtc_connection_callback=webrtc_connection_callback,
    )
    if answer is None:
        raise HTTPException(status_code=500, detail="Failed to produce WebRTC answer")
    return answer


@app.patch("/api/offer")
async def ice_candidate(request: Request) -> dict[str, str]:
    """Accept trickle ICE candidates from the Pipecat SmallWebRTC client."""
    body = await request.json()
    try:
        raw_candidates = body.get("candidates") or []
        candidates = [
            IceCandidate(
                candidate=c["candidate"],
                sdp_mid=c.get("sdp_mid") or c.get("sdpMid") or "",
                sdp_mline_index=int(c.get("sdp_mline_index", c.get("sdpMLineIndex", 0))),
            )
            for c in raw_candidates
        ]
        patch = SmallWebRTCPatchRequest(
            pc_id=body["pc_id"] if "pc_id" in body else body["pcId"],
            candidates=candidates,
        )
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=400, detail=f"Invalid ICE patch: {exc}") from exc

    await small_webrtc_handler.handle_patch_request(patch)
    return {"status": "success"}


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(
        "server:app",
        host=os.getenv("BACKEND_HOST", "0.0.0.0"),
        port=int(os.getenv("BACKEND_PORT", "8000")),
        reload=True,
    )
