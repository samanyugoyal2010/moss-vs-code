"use client";

import { PipecatClient } from "@pipecat-ai/client-js";
import { SmallWebRTCTransport } from "@pipecat-ai/small-webrtc-transport";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

type SessionState = "idle" | "connecting" | "active";

type LatencyMetrics = {
  sttMs: number;
  mossMs: number;
  llmTtftMs: number;
  totalMs: number;
};

type GradeFeedback = {
  topic: string | null;
  score: number;
  maxScore: number;
  summary: string;
  tips: string[];
};

type AssistPanelState = {
  currentQuestion: string | null;
  userAnswer: string | null;
  grading: boolean;
  feedback: GradeFeedback | null;
};

const EMPTY_ASSIST: AssistPanelState = {
  currentQuestion: null,
  userAnswer: null,
  grading: false,
  feedback: null,
};

const BACKEND_URL = process.env.NEXT_PUBLIC_BACKEND_URL ?? "http://localhost:8000";

const TARGET_LATENCY: LatencyMetrics = {
  sttMs: 150,
  mossMs: 5,
  llmTtftMs: 200,
  totalMs: 355,
};

function formatMs(value: number, digits = 0): string {
  if (value < 10 && digits === 0) {
    return value.toFixed(1);
  }
  return value.toFixed(digits);
}

function parseDataPayload(data: unknown): Record<string, unknown> | null {
  try {
    if (typeof data === "string") {
      return JSON.parse(data) as Record<string, unknown>;
    }
    if (data instanceof ArrayBuffer) {
      return JSON.parse(new TextDecoder().decode(data)) as Record<string, unknown>;
    }
    if (data instanceof Uint8Array) {
      return JSON.parse(new TextDecoder().decode(data)) as Record<string, unknown>;
    }
    if (data && typeof data === "object") {
      return data as Record<string, unknown>;
    }
  } catch {
    return null;
  }
  return null;
}

function extractQuestionFromBotText(text: string): string {
  const cleaned = text.replace(/\s+/g, " ").trim();
  if (!cleaned) return cleaned;
  const parts = cleaned.split(/(?<=[.?!])\s+/);
  const questions = parts.filter((p) => p.includes("?"));
  return (questions.at(-1) ?? parts.at(-1) ?? cleaned).trim();
}

export default function HomePage() {
  const [session, setSession] = useState<SessionState>("idle");
  const [error, setError] = useState<string | null>(null);
  const [latency, setLatency] = useState<LatencyMetrics>(TARGET_LATENCY);
  const [interruptFlash, setInterruptFlash] = useState(false);
  const [interruptCount, setInterruptCount] = useState(0);
  const [aiTalking, setAiTalking] = useState(false);
  const [userTalking, setUserTalking] = useState(false);
  const [localLevel, setLocalLevel] = useState(0);
  const [remoteLevel, setRemoteLevel] = useState(0);
  const [assist, setAssist] = useState<AssistPanelState>(EMPTY_ASSIST);

  const clientRef = useRef<PipecatClient | null>(null);
  const botAudioRef = useRef<HTMLAudioElement | null>(null);
  const botTranscriptBuf = useRef("");

  const handleServerMessage = useCallback((raw: unknown) => {
    const msg = parseDataPayload(raw);
    if (!msg) return;

    if (msg.type === "interruption" && msg.interrupted) {
      setInterruptCount((c) => c + 1);
      setInterruptFlash(true);
      window.setTimeout(() => setInterruptFlash(false), 900);
      return;
    }

    if (msg.type === "current_question" && typeof msg.text === "string") {
      setAssist((prev) => ({
        ...prev,
        currentQuestion: msg.text as string,
      }));
      return;
    }

    if (msg.type === "user_answer" && typeof msg.text === "string") {
      setAssist((prev) => ({
        ...prev,
        userAnswer: msg.text as string,
        grading: true,
        feedback: null,
      }));
      return;
    }

    if (msg.type === "grading_started") {
      setAssist((prev) => ({ ...prev, grading: true }));
      return;
    }

    if (msg.type === "grade_result") {
      const tips = Array.isArray(msg.tips)
        ? msg.tips.filter((t): t is string => typeof t === "string")
        : [];
      setAssist((prev) => ({
        ...prev,
        grading: false,
        feedback: {
          topic: typeof msg.topic === "string" ? msg.topic : null,
          score: typeof msg.score === "number" ? msg.score : 3,
          maxScore: typeof msg.max_score === "number" ? msg.max_score : 5,
          summary:
            typeof msg.summary === "string"
              ? msg.summary
              : "Review the rubric points for this topic.",
          tips,
        },
      }));
      return;
    }

    if (msg.type === "latency" || "moss_ms" in msg || "llm_ttft_ms" in msg) {
      setLatency((prev) => {
        const sttMs = typeof msg.stt_ms === "number" ? msg.stt_ms : prev.sttMs;
        const mossMs = typeof msg.moss_ms === "number" ? msg.moss_ms : prev.mossMs;
        const llmTtftMs =
          typeof msg.llm_ttft_ms === "number" ? msg.llm_ttft_ms : prev.llmTtftMs;
        const totalMs =
          typeof msg.total_ms === "number" ? msg.total_ms : sttMs + mossMs + llmTtftMs;
        return { sttMs, mossMs, llmTtftMs, totalMs };
      });

      if (msg.interrupted === true) {
        setInterruptCount((c) => c + 1);
        setInterruptFlash(true);
        window.setTimeout(() => setInterruptFlash(false), 900);
      }
    }
  }, []);

  const attachBotAudio = useCallback((track: MediaStreamTrack) => {
    // SmallWebRTCTransport defaults DailyMediaManager(enablePlayer=false), so
    // remote WebRTC audio must be wired to an <audio> element manually.
    const el = botAudioRef.current;
    if (!el) return;
    el.srcObject = new MediaStream([track]);
    el.muted = false;
    el.volume = 1;
    void el.play().catch((err: unknown) => {
      console.warn("Bot audio autoplay blocked:", err);
    });
  }, []);

  const endInterview = useCallback(async () => {
    const client = clientRef.current;
    clientRef.current = null;
    setSession("idle");
    setAiTalking(false);
    setUserTalking(false);
    setLocalLevel(0);
    setRemoteLevel(0);
    setAssist(EMPTY_ASSIST);
    botTranscriptBuf.current = "";
    if (botAudioRef.current) {
      botAudioRef.current.pause();
      botAudioRef.current.srcObject = null;
    }
    if (client) {
      try {
        await client.disconnect();
      } catch {
        // Best-effort disconnect
      }
    }
  }, []);

  const startInterview = useCallback(async () => {
    setError(null);
    setSession("connecting");
    setInterruptCount(0);
    setLatency(TARGET_LATENCY);
    setLocalLevel(0);
    setRemoteLevel(0);
    setAssist(EMPTY_ASSIST);
    botTranscriptBuf.current = "";

    try {
      const health = await fetch(`${BACKEND_URL}/health`);
      if (health.ok) {
        const body = (await health.json()) as { moss_ready?: boolean };
        if (body.moss_ready === false) {
          throw new Error(
            "Moss index not loaded. Run ingest_knowledge.py and restart the backend.",
          );
        }
      }

      const client = new PipecatClient({
        transport: new SmallWebRTCTransport({
          iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
          waitForICEGathering: true,
        }),
        enableCam: false,
        enableMic: true,
        callbacks: {
          onConnected: () => setSession("active"),
          onBotReady: () => setSession("active"),
          onDisconnected: () => {
            setSession("idle");
            clientRef.current = null;
            setLocalLevel(0);
            setRemoteLevel(0);
            setAssist(EMPTY_ASSIST);
            botTranscriptBuf.current = "";
            if (botAudioRef.current) {
              botAudioRef.current.pause();
              botAudioRef.current.srcObject = null;
            }
          },
          onBotStartedSpeaking: () => {
            setAiTalking(true);
            botTranscriptBuf.current = "";
          },
          onBotStoppedSpeaking: () => {
            setAiTalking(false);
            const question = extractQuestionFromBotText(botTranscriptBuf.current);
            if (question) {
              setAssist((prev) =>
                prev.currentQuestion ? prev : { ...prev, currentQuestion: question },
              );
            }
          },
          onUserStartedSpeaking: () => setUserTalking(true),
          onUserStoppedSpeaking: () => setUserTalking(false),
          onLocalAudioLevel: (level: number) => setLocalLevel(level),
          onRemoteAudioLevel: (level: number) => setRemoteLevel(level),
          onUserTranscript: (data) => {
            if (!data.final || !data.text.trim()) return;
            setAssist((prev) => ({
              ...prev,
              userAnswer: data.text.trim(),
            }));
          },
          onBotTranscript: (data) => {
            if (!data.text) return;
            botTranscriptBuf.current += data.text;
          },
          onBotLlmText: (data) => {
            if (!data.text) return;
            botTranscriptBuf.current += data.text;
          },
          onTrackStarted: (track, participant) => {
            if (track.kind !== "audio") return;
            // Local mic should not be played back into speakers.
            if (participant?.local) return;
            attachBotAudio(track);
          },
          onServerMessage: (data: unknown) => handleServerMessage(data),
          onError: (message) => {
            const detail =
              typeof message === "object" && message && "data" in message
                ? JSON.stringify((message as { data?: unknown }).data)
                : "WebRTC connection error";
            setError(detail);
            setSession("idle");
          },
        },
      });

      clientRef.current = client;
      await client.initDevices();
      await client.connect({
        webrtcUrl: `${BACKEND_URL}/api/offer`,
      });
      setSession("active");

      // In case the remote track arrived before the callback was wired.
      const remote = client.tracks()?.bot?.audio;
      if (remote) attachBotAudio(remote);
    } catch (err) {
      clientRef.current = null;
      setSession("idle");
      setError(err instanceof Error ? err.message : "Unable to start interview");
    }
  }, [attachBotAudio, handleServerMessage]);

  useEffect(() => {
    return () => {
      void clientRef.current?.disconnect();
    };
  }, []);

  const activeLevel = Math.max(localLevel, remoteLevel);
  const ringAi = aiTalking || remoteLevel > 0.08;
  const ringUser = userTalking || localLevel > 0.08;

  return (
    <main className="relative min-h-screen overflow-hidden px-6 py-10 md:px-12 md:py-14">
      {/* Bot audio: SmallWebRTC does not autoplay remote tracks by default */}
      <audio ref={botAudioRef} autoPlay playsInline className="hidden" />
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 opacity-[0.07]"
        style={{
          backgroundImage:
            "linear-gradient(rgba(232,240,236,0.5) 1px, transparent 1px), linear-gradient(90deg, rgba(232,240,236,0.5) 1px, transparent 1px)",
          backgroundSize: "48px 48px",
          maskImage: "radial-gradient(ellipse at center, black 20%, transparent 75%)",
        }}
      />

      {session === "idle" && <IdleView onStart={() => void startInterview()} error={error} />}
      {session === "connecting" && <ConnectingView />}
      {session === "active" && (
        <ActiveInterview
          latency={latency}
          interruptCount={interruptCount}
          interruptFlash={interruptFlash}
          aiTalking={ringAi}
          userTalking={ringUser}
          activeLevel={activeLevel}
          assist={assist}
          onEnd={() => void endInterview()}
        />
      )}
    </main>
  );
}

function IdleView({ onStart, error }: { onStart: () => void; error: string | null }) {
  return (
    <section className="relative z-10 mx-auto flex min-h-[80vh] max-w-3xl flex-col justify-center">
      <p className="mb-4 text-xs font-semibold tracking-[0.28em] text-[var(--accent)] uppercase">
        Moss · Sub-10ms retrieval
      </p>
      <h1 className="font-display text-5xl leading-[1.05] tracking-tight text-[var(--cream)] md:text-7xl">
        Moss Interview Coach
      </h1>
      <p className="mt-6 max-w-xl text-lg leading-relaxed text-[var(--fog)] md:text-xl">
        A real-time system design voice coach. Rubrics land from Moss in milliseconds — Whisper,
        Piper, and Ollama stay fully local. Only Moss keys required.
      </p>
      <div className="mt-10 flex flex-wrap items-center gap-4">
        <button
          type="button"
          onClick={onStart}
          className="rounded-md bg-[var(--accent)] px-7 py-3.5 text-sm font-semibold tracking-wide text-[var(--ink)] transition hover:brightness-110 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--accent)]"
        >
          Start Interview
        </button>
        <span className="text-sm text-[var(--fog)]">Whisper · Ollama llama3 · Piper</span>
      </div>
      {error && (
        <p className="mt-6 max-w-xl rounded-md border border-[var(--danger)]/40 bg-[var(--danger)]/10 px-4 py-3 text-sm text-[var(--danger)]">
          {error}
        </p>
      )}
    </section>
  );
}

function ConnectingView() {
  return (
    <section className="relative z-10 mx-auto flex min-h-[80vh] max-w-lg flex-col items-center justify-center text-center">
      <div className="loading-shimmer mb-6 h-1.5 w-48 rounded-full" />
      <h2 className="font-display text-3xl text-[var(--cream)]">Negotiating WebRTC…</h2>
      <p className="mt-3 text-[var(--fog)]">
        Peer-to-peer SmallWebRTC handshake with the local Pipecat agent.
      </p>
    </section>
  );
}

function ActiveInterview({
  latency,
  interruptCount,
  interruptFlash,
  aiTalking,
  userTalking,
  activeLevel,
  assist,
  onEnd,
}: {
  latency: LatencyMetrics;
  interruptCount: number;
  interruptFlash: boolean;
  aiTalking: boolean;
  userTalking: boolean;
  activeLevel: number;
  assist: AssistPanelState;
  onEnd: () => void;
}) {
  const ringScale = 1 + activeLevel * 0.45;

  return (
    <section className="relative z-10 mx-auto flex min-h-[82vh] max-w-6xl flex-col">
      <header className="mb-8 flex items-start justify-between gap-6">
        <div>
          <p className="font-display text-3xl text-[var(--cream)] md:text-4xl">
            Moss Interview Coach
          </p>
          <p className="mt-1 text-sm text-[var(--fog)]">SmallWebRTC · local voice stack</p>
        </div>
        <button
          type="button"
          onClick={onEnd}
          className="rounded-md border border-[var(--cream)]/25 px-4 py-2 text-sm font-medium text-[var(--cream)] transition hover:border-[var(--danger)] hover:text-[var(--danger)]"
        >
          End Interview
        </button>
      </header>

      <div className="grid flex-1 gap-10 lg:grid-cols-[minmax(0,1.05fr)_minmax(280px,0.85fr)] lg:items-start lg:gap-14">
        <div className="flex flex-col items-center justify-center gap-10 md:flex-row md:items-center md:justify-between lg:flex-col lg:items-center xl:flex-row">
          <div className="relative flex h-64 w-64 items-center justify-center md:h-72 md:w-72">
            <div
              className={`absolute inset-0 rounded-full border border-[var(--accent)]/30 ${
                aiTalking || userTalking ? "ring-pulse" : ""
              }`}
              style={{
                boxShadow: `0 0 ${24 + activeLevel * 60}px rgba(61, 255, 168, ${0.15 + activeLevel * 0.45})`,
                transform: `scale(${ringScale})`,
                transition: "transform 80ms linear, box-shadow 80ms linear",
                borderColor: userTalking ? "var(--ring-user)" : "var(--ring-ai)",
              }}
            />
            <div
              className="absolute inset-6 rounded-full border border-[var(--cream)]/10 bg-[var(--panel)]/80 backdrop-blur-sm"
              style={{
                boxShadow: aiTalking
                  ? "inset 0 0 40px rgba(61,255,168,0.18)"
                  : userTalking
                    ? "inset 0 0 40px rgba(94,234,212,0.18)"
                    : "none",
              }}
            />
            <div className="relative z-10 text-center">
              <p className="text-xs tracking-[0.22em] text-[var(--fog)] uppercase">
                {aiTalking ? "Coach speaking" : userTalking ? "You speaking" : "Listening"}
              </p>
              <p className="font-display mt-2 text-2xl text-[var(--cream)]">
                {aiTalking ? "AI" : userTalking ? "You" : "Ready"}
              </p>
            </div>
          </div>

          <div className="w-full max-w-md space-y-5">
            <div
              className={`border-y border-[var(--cream)]/10 py-4 ${
                interruptFlash ? "interrupt-flash" : ""
              }`}
            >
              <div className="flex items-center justify-between">
                <p className="text-xs tracking-[0.2em] text-[var(--fog)] uppercase">
                  Interruption Meter
                </p>
                <span
                  className={`text-sm font-semibold ${
                    interruptFlash ? "text-[var(--warn)]" : "text-[var(--cream)]"
                  }`}
                >
                  {interruptCount > 0 ? "Barge-in OK" : "Standby"}
                </span>
              </div>
              <div className="mt-3 h-2 overflow-hidden rounded-full bg-[var(--ink)]">
                <div
                  className="h-full rounded-full bg-[var(--warn)] transition-all duration-300"
                  style={{
                    width: `${Math.min(100, interruptCount * 20 + (interruptFlash ? 40 : 8))}%`,
                  }}
                />
              </div>
              <p className="mt-2 text-xs text-[var(--fog)]">
                Successful interruptions: {interruptCount}
              </p>
            </div>

            <LatencyHud latency={latency} />
          </div>
        </div>

        <AssistPanel assist={assist} />
      </div>
    </section>
  );
}

function AssistPanel({ assist }: { assist: AssistPanelState }) {
  const { currentQuestion, userAnswer, grading, feedback } = assist;

  return (
    <aside className="assist-panel flex h-full min-h-[28rem] flex-col border-l border-[var(--accent)]/20 pl-0 lg:pl-8">
      <p className="mb-6 text-xs tracking-[0.28em] text-[var(--accent)] uppercase">
        Assist · live feedback
      </p>

      <div className="space-y-8">
        <div>
          <p className="mb-2 text-xs tracking-[0.18em] text-[var(--fog)] uppercase">
            Current question
          </p>
          {currentQuestion ? (
            <p className="font-display text-2xl leading-snug text-[var(--cream)] md:text-[1.65rem]">
              {currentQuestion}
            </p>
          ) : (
            <p className="text-sm text-[var(--fog)]">
              Waiting for the coach to finish asking…
            </p>
          )}
        </div>

        <div>
          <p className="mb-2 text-xs tracking-[0.18em] text-[var(--fog)] uppercase">
            Your answer
          </p>
          {userAnswer ? (
            <p className="text-sm leading-relaxed text-[var(--fog)] line-clamp-5">
              {userAnswer}
            </p>
          ) : (
            <p className="text-sm text-[var(--fog)]/70">
              Speak after the question to see a snippet here.
            </p>
          )}
        </div>

        <div>
          <div className="mb-2 flex items-center justify-between gap-3">
            <p className="text-xs tracking-[0.18em] text-[var(--fog)] uppercase">Feedback</p>
            {feedback && (
              <span className="font-mono text-sm font-semibold tabular-nums text-[var(--accent)]">
                {feedback.score}/{feedback.maxScore}
              </span>
            )}
          </div>

          {grading && !feedback && (
            <p className="assist-grading text-sm text-[var(--accent)]/80">
              Grading against Moss rubric…
            </p>
          )}

          {feedback && (
            <div className="space-y-3">
              {feedback.topic && (
                <p className="text-xs text-[var(--fog)]">Topic · {feedback.topic}</p>
              )}
              <p className="text-sm leading-relaxed text-[var(--cream)]">{feedback.summary}</p>
              {feedback.tips.length > 0 && (
                <ul className="space-y-2 border-t border-[var(--cream)]/10 pt-3">
                  {feedback.tips.map((tip) => (
                    <li key={tip} className="flex gap-2 text-sm leading-snug text-[var(--fog)]">
                      <span className="mt-1.5 h-1 w-1 shrink-0 rounded-full bg-[var(--accent)]" />
                      <span>{tip}</span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}

          {!grading && !feedback && (
            <p className="text-sm text-[var(--fog)]/70">
              After you answer, a silent Ollama pass scores the turn and lists improvement tips —
              without interrupting the coach.
            </p>
          )}
        </div>
      </div>
    </aside>
  );
}

function LatencyHud({ latency }: { latency: LatencyMetrics }) {
  const rows = useMemo(
    () => [
      {
        label: "Speech-to-Text",
        value: `~${formatMs(latency.sttMs)}ms`,
        highlight: false as const,
      },
      {
        label: "Moss Retrieval",
        value: `<${formatMs(Math.max(latency.mossMs, 0.1), latency.mossMs < 10 ? 1 : 0)}ms`,
        highlight: true as const,
      },
      {
        label: "LLM Time-to-First-Token",
        value: `~${formatMs(latency.llmTtftMs)}ms`,
        highlight: false as const,
      },
      {
        label: "Total Turn-Around Latency",
        value: `~${formatMs(latency.totalMs)}ms`,
        highlight: false as const,
      },
    ],
    [latency],
  );

  return (
    <div className="border-y border-[var(--cream)]/10 py-4">
      <p className="mb-3 text-xs tracking-[0.2em] text-[var(--fog)] uppercase">
        Real-Time Latency HUD
      </p>
      <ul className="space-y-2.5">
        {rows.map((row) => (
          <li
            key={row.label}
            className={`flex items-center justify-between gap-4 px-1 py-1.5 ${
              row.highlight ? "text-[var(--accent)]" : ""
            }`}
          >
            <span className="text-sm text-[var(--fog)]">{row.label}</span>
            <span
              className={`font-mono text-sm font-semibold tabular-nums ${
                row.highlight ? "text-[var(--accent)]" : "text-[var(--cream)]"
              }`}
            >
              {row.value}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
