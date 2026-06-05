/**
 * OpenAI Whisper API wrapper.
 *
 * Whisper pricing (2025): $0.006 per minute of audio.
 * We track per-lesson cost in lessons.transcription_cost_usd for billing.
 *
 * Reads OPENAI_API_KEY from env — shared key, Askine pays, recharges via
 * usage_events to tenants in Phase 3 billing.
 */

import { openAsBlob } from "node:fs";

export interface WhisperSegment {
  start: number;
  end: number;
  text: string;
}

export interface WhisperResult {
  language: string;
  durationSec: number;
  segments: WhisperSegment[];
  fullText: string;
  costUsd: number;
}

interface OpenAIVerboseJson {
  task: string;
  language: string;
  duration: number;
  text: string;
  segments: Array<{ id: number; start: number; end: number; text: string }>;
}

const WHISPER_USD_PER_MIN = 0.006;

export async function transcribeAudioFile(args: {
  audioPath: string;
  filename?: string;
  language?: string;
  prompt?: string;
}): Promise<WhisperResult> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey || apiKey.startsWith("sk-REPLACE")) {
    throw new Error("OPENAI_API_KEY not set");
  }

  const form = new FormData();
  form.append("file", await openAsBlob(args.audioPath), args.filename ?? "audio.mp3");
  form.append("model", "whisper-1");
  if (args.language) form.append("language", args.language);
  form.append("response_format", "verbose_json");
  if (args.prompt) form.append("prompt", args.prompt);

  const res = await fetch("https://api.openai.com/v1/audio/transcriptions", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}` },
    body: form,
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`OpenAI Whisper ${res.status}: ${body}`);
  }
  const data = await res.json() as OpenAIVerboseJson;
  const durationSec = Math.round(data.duration || 0);
  return {
    language: data.language || args.language || "pt",
    durationSec,
    segments: data.segments.map((s) => ({ start: s.start, end: s.end, text: s.text.trim() })),
    fullText: data.text.trim(),
    costUsd: Number(((durationSec / 60) * WHISPER_USD_PER_MIN).toFixed(4)),
  };
}
